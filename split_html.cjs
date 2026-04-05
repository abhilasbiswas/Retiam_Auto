const fs = require('fs');

const content = fs.readFileSync('src/original_engine.html', 'utf-8');

const htmlStart = content.indexOf('<!DOCTYPE html>');
const htmlEnd = content.indexOf('<script>');
const scriptEnd = content.lastIndexOf('</script>');
const htmlEndTag = content.indexOf('</body>');

const styleStart = content.indexOf('<style>');
const styleEnd = content.indexOf('</style>');

if (styleStart !== -1 && styleEnd !== -1) {
    const css = content.substring(styleStart + '<style>'.length, styleEnd);
    fs.writeFileSync('src/style.css', css.trim());
}

// Rebuild index.html
let newHtml = content.substring(htmlStart, styleStart);
newHtml += '    <link rel="stylesheet" href="/src/style.css">\n';
newHtml += content.substring(styleEnd + '</style>'.length, htmlEnd);
newHtml += '\n    <script type="module" src="/src/main.ts"></script>\n';
newHtml += content.substring(scriptEnd + '</script>'.length);

fs.writeFileSync('index.html', newHtml.trim());

// Finally clean up tmp files
console.log('HTML and CSS separated.');
