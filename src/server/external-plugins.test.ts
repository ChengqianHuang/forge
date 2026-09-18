import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { externalPluginsDir, loadExternalPlugins } from "./external-plugins.ts";

test("loads a valid external plugin and isolates broken ones", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-ext-"));
  try {
    await mkdir(externalPluginsDir(home), { recursive: true });
    await writeFile(join(externalPluginsDir(home), "greet.plugin.ts"), `
      const plugin = {
        manifest: {
          id: "ext.greet",
          name: "Greet",
          version: "1.0.0",
          capabilities: ["slash-command"],
          configSchema: [{ key: "who", label: "Who", type: "string", default: "world" }],
        },
        activate: (context, config) => ({
          slashCommands: [{
            name: "greet",
            description: "say hi",
            execute: () => ({ message: \`hi \${config.who} from \${context.session.id}\` }),
          }],
        }),
      };
      export default plugin;
    `);
    await writeFile(join(externalPluginsDir(home), "bad-manifest.plugin.ts"), `
      export default { manifest: { id: "ext.bad" }, activate: () => ({}) };
    `);
    await writeFile(join(externalPluginsDir(home), "broken.plugin.ts"), "export default ((", "utf8");
    // Non-plugin files are invisible to the contract.
    await writeFile(join(externalPluginsDir(home), "README.md"), "not a plugin", "utf8");

    const { plugins, errors } = await loadExternalPlugins(home);
    assert.deepEqual(plugins.map((p) => p.manifest.id), ["ext.greet"]);
    assert.equal(errors.length, 2, JSON.stringify(errors));
    assert.ok(errors.some((e) => e.source === "bad-manifest.plugin.ts" && /manifest name is required/.test(e.reason)));
    assert.ok(errors.some((e) => e.source === "broken.plugin.ts"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a missing plugins directory is an empty result, not an error", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-ext-"));
  try {
    assert.deepEqual(await loadExternalPlugins(home), { plugins: [], errors: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
