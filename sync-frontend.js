const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = __dirname;
execFileSync("go", ["run", "./tools/prepare-desktop-assets"], {
  cwd: root,
  stdio: "inherit",
});

const out = path.join(root, "frontend");
fs.mkdirSync(out, { recursive: true });

for (const name of ["index.html", "style.css", "app.js"]) {
  fs.copyFileSync(path.join(root, name), path.join(out, name));
}
console.log("frontend synced");
