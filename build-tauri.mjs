import fs from 'fs';
import path from 'path';

const dist = './dist';

// Files and folders to copy
const assetsToCopy = [
    'index.html',
    'landing.html',
    'styles.css',
    'app.js',
    'manifest.json',
    'sw.js',
    'assets',
    'audio'
];

if (!fs.existsSync(dist)) {
    fs.mkdirSync(dist);
}

function copyRecursiveSync(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    if (isDirectory) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest);
        fs.readdirSync(src).forEach(function(childItemName) {
            copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
    } else if (exists) {
        fs.copyFileSync(src, dest);
    }
}

assetsToCopy.forEach(item => {
    copyRecursiveSync(path.resolve('.', item), path.resolve('.', dist, item));
});

console.log('Successfully copied frontend assets to dist/ for Tauri build!');
