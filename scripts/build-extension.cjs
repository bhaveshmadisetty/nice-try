// Dependency-free runtime bundle. Never copy the entire development workspace.
const fs = require("node:fs");
const path = require("node:path");
const root = require("../extension-root.cjs");
const development = path.resolve(__dirname, "..");
const output = path.join(development, "build", "extension");
const excluded = new Set(["__sbx.html", ".__drive.js", "done-sandbox.html", "done-sandbox.js"]);
if (fs.existsSync(path.join(development, "build")) && fs.lstatSync(path.join(development, "build")).isSymbolicLink()) {
  throw new Error("Refusing to write through a linked build directory.");
}
if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
  throw new Error("Refusing to replace a linked output directory.");
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
let count = 0, bytes = 0;
function copy(relative) {
  const source = path.join(root, relative);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Unexpected link: ${relative}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(source)) {
      if (!excluded.has(name) && !name.startsWith(".") && !(relative === "assets" && name === "source")) {
        copy(path.join(relative, name));
      }
    }
  } else {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    count++;
    bytes += stat.size;
  }
}
for (const entry of ["manifest.json", "src", "ui", "assets", "config"]) copy(entry);
console.log(`Extension bundle: ${output}\n${count} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
