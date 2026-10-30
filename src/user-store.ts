import { constants } from "node:fs";
import { open, mkdir, lstat, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { BridgeError } from "./user-api";

export function bridgeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.REGENIC_SLACK_USER_DIR ?? join(homedir(), ".regenic", "slack-user");
  if (!isAbsolute(path) || path.includes("\0")) throw new BridgeError("absolute_private_directory_required");
  return resolve(path);
}
export async function checkPrivate(path: string, kind: "directory" | "socket" | "file") {
  const stat = await lstat(path);
  if (stat.uid !== process.getuid?.() || stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      !(kind === "directory" ? stat.isDirectory() : kind === "socket" ? stat.isSocket() : stat.isFile())) {
    throw new BridgeError("unsafe_local_path");
  }
}
export class PrivateStore {
  constructor(readonly directory: string) {
    if (!isAbsolute(directory) || resolve(directory) !== directory) throw new BridgeError("absolute_private_directory_required");
  }
  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await checkPrivate(this.directory, "directory");
  }
  async lock(): Promise<() => Promise<void>> {
    await this.prepare();
    const path = join(this.directory, "owner.lock");
    let file;
    try {
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BridgeError("already_owned_manual_recovery_required");
      throw error;
    }
    try {
      await file.writeFile(`${process.pid}\n`);
      await file.sync();
    } catch (error) {
      await file.close();
      await unlink(path);
      throw error;
    }
    return async () => { await file.close(); await unlink(path); };
  }
  async read(name: string): Promise<unknown | undefined> {
    const path = this.path(name);
    try {
      await checkPrivate(path, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new BridgeError("unsafe_local_path");
      return JSON.parse(await file.readFile("utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new BridgeError("corrupt_local_store");
      throw error;
    } finally { await file.close(); }
  }
  async write(name: string, value: unknown) {
    const path = this.path(name);
    const temp = this.path(`${name}.${randomUUID()}.tmp`);
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally { await file.close(); }
      await rename(temp, path);
      const directory = await open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await unlink(temp).catch((cleanup: NodeJS.ErrnoException) => {
        if (cleanup.code !== "ENOENT") throw cleanup;
      });
      throw error;
    }
  }
  private path(name: string) {
    if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw new BridgeError("invalid_store_name");
    return join(this.directory, name);
  }
}
