/**
 * File System and Environment Adapter
 * This module abstracts OS-level operations. 
 * If you ever switch from Deno to Node.js, you only need to change this file.
 */

function resolvePath(filePath) {
  if (/^(?:[a-zA-Z]:[\\/]|\\|\/)/.test(filePath)) {
    return filePath;
  }
  return `${import.meta.dirname}/${filePath}`;
}

export async function readTextFile(filePath) {
  // Deno implementation:
  return await Deno.readTextFile(resolvePath(filePath));
  
  // Node.js implementation:
  // const fs = await import("fs/promises");
  // return await fs.readFile(resolvePath(filePath), "utf-8");
}

export async function writeTextFile(filePath, content) {
  // Deno implementation:
  await Deno.writeTextFile(resolvePath(filePath), content);
  
  // Node.js implementation:
  // const fs = await import("fs/promises");
  // await fs.writeFile(resolvePath(filePath), content, "utf-8");
}

export function getEnv(key) {
  // Deno implementation:
  return Deno.env.get(key);
  
  // Node.js implementation:
  // return process.env[key];
}
