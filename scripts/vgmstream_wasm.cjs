// node vgm.cjs <vgmstream-cli.js> <outdir> <file...> -- <vgmstream args naming files by basename>
// Runs vgmstream's wasm CLI: inputs are copied into its in-memory FS before main, and every new
// file it writes is copied to <outdir> afterwards.
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const [cliJs, outdir, ...rest] = process.argv.slice(2);
const sep = rest.indexOf("--");
const inputs = rest.slice(0, sep);
const args = rest.slice(sep + 1);
let before = null;
const copyOut = () => {
  if (!before) return;
  for (const name of FS.readdir("/work")) {
    if (before.has(name)) continue;
    fs.writeFileSync(path.join(outdir, name), FS.readFile("/work/" + name));
  }
  before = null;
};
globalThis.Module = {
  arguments: args,
  thisProgram: "vgmstream-cli",
  locateFile: (p) => path.join(path.dirname(cliJs), p),
  preRun: [
    () => {
      FS.mkdir("/work");
      for (const f of inputs) FS.writeFile("/work/" + path.basename(f), fs.readFileSync(f));
      FS.chdir("/work");
      before = new Set(FS.readdir("/work"));
    },
  ],
  postRun: [copyOut],
};
process.on("exit", copyOut);
globalThis.require = require;
globalThis.__dirname = path.dirname(cliJs);
globalThis.__filename = cliJs;
vm.runInThisContext(fs.readFileSync(cliJs, "utf8"), { filename: cliJs });
