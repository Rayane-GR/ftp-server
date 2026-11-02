'use strict';

/**
 * Generates PNG icons + favicon from the SVG source using ImageMagick
 * (available in the build sandbox). Run once; output is committed.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'public', 'icons');
const svg = path.join(dir, 'icon.svg');

const jobs = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
];

if (!fs.existsSync(svg)) {
  console.error('missing icon.svg');
  process.exit(1);
}

for (const [name, size] of jobs) {
  const out = path.join(dir, name);
  execFileSync('convert', [
    '-background',
    'none',
    '-density',
    '384',
    svg,
    '-resize',
    `${size}x${size}`,
    '-gravity',
    'center',
    '-extent',
    `${size}x${size}`,
    out,
  ]);
  console.log(`wrote ${name} (${fs.statSync(out).size} bytes)`);
}

execFileSync('convert', [
  '-background',
  'none',
  '-density',
  '192',
  svg,
  '-resize',
  '64x64',
  path.join(dir, 'favicon.png'),
]);
fs.copyFileSync(svg, path.join(dir, 'favicon.svg'));
console.log('wrote favicon.svg + favicon.png');
