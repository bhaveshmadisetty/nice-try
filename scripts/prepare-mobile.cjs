// Run after changing the shared protocol or the public Firebase configuration.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = require("../extension-root.cjs");
const development = path.resolve(__dirname, "..");
for (const file of ["task-core.js", "task-cloud.js"]) {
  fs.copyFileSync(path.join(root, "src", file), path.join(development, "mobile/lib", file));
}
const scope = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "config/sync-config.js"), "utf8"), scope);
const config = scope.NiceTrySyncConfig.firebase;
const publicConfig = Object.fromEntries(["apiKey", "authDomain", "projectId", "appId"].map(key => [key, config[key] || ""]));
fs.writeFileSync(path.join(development, "mobile/lib/sync-config.json"), JSON.stringify(publicConfig, null, 2) + "\n");
console.log("Shared task protocol and public Firebase configuration prepared.");
