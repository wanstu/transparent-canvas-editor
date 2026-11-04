const fs=require('fs');
let html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('style.css','utf8');
const js=fs.readFileSync('app.js','utf8');
html=html.replace('<link rel="stylesheet" href="style.css">','<style>\n'+css+'\n</style>');
html=html.replace('<script src="app.js"></script>','<script>\n'+js.replace(/<\\\/script/gi,'<\\/script')+'\n</script>');
fs.writeFileSync('transparent_canvas_editor.html',html,'utf8');
console.log('single html bytes='+Buffer.byteLength(html));