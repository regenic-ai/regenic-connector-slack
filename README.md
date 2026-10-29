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

Regenic's built-in connector host only ships Feishu, DSH and Cursor. To run Slack, add this
package to your own deployment's connector host and register `slackChannelDriver` alongside the
built-in drivers.
