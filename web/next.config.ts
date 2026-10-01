import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The repo root holds the batch scripts and has its own lockfile, so Turbopack has to
  // be told that the app's root is this folder. Without it the build warns and resolves
  // from the wrong directory.
  turbopack: { root: __dirname },
};

export default nextConfig;
