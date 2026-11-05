const fs = require("fs");
const path = require("path");

const root = __dirname;
const out = path.join(root, "frontend");
fs.mkdirSync(out, { recursive: true });

for (const name of ["index.html", "style.css", "app.js"]) {
  fs.copyFileSync(path.join(root, name), path.join(out, name));
}
console.log("frontend synced");
