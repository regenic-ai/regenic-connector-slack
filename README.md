# regenic-connector-slack

Slack channel connector for Regenic (`@regenic/slack-connector`), split out of the main
`regenic-ai/regenic` repository. It is no longer bundled with Regenic.

It contributes the `slackChannelDriver` channel driver (`connector_type: "slack-channel"`) and the
`slackChannelPlugin` plugin, built against the published Regenic connector SDK
(`@regenic/plugin-host`, `@regenic/connector-contract`, `@regenic/connector-test-utils`).

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
```

## Using it with Regenic

Regenic's built-in connector host only ships Feishu, DSH and Cursor. Load this package as an
external plugin (its `package.json` already declares the `regenic.plugin` manifest):

```sh
pnpm install && pnpm build
# either point at this package directly
REGENIC_CHANNEL_PLUGIN=/path/to/regenic-connector-slack
# or link/copy it into the plugin directory (default ~/.regenic/plugins)
ln -s /path/to/regenic-connector-slack ~/.regenic/plugins/slack-connector
```

Set `REGENIC_SLACK_TOKEN` before starting Regenic, then install **Slack** from **Engine**.
