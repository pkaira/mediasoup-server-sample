const path = require('path');
const fs = require('fs');
const { defineConfig } = require('vite');

// Check if SSL certificates exist for development server
const certPath = path.resolve(__dirname, 'certs', 'cert.pem');
const keyPath = path.resolve(__dirname, 'certs', 'key.pem');
const sslExists = fs.existsSync(certPath) && fs.existsSync(keyPath);

// Determine the backend URL based on SSL availability and environment
const getBackendUrl = () => {
  const sslEnabled = process.env.SSL_ENABLED === 'true';
  const backendPort = sslEnabled ? (process.env.SSL_PORT || 3443) : (process.env.PORT || 3000);
  const protocol = sslEnabled ? 'https' : 'http';
  return `${protocol}://localhost:${backendPort}`;
};

module.exports = defineConfig({
  root: path.resolve(__dirname, 'client'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true
  },
  server: {
    host: '0.0.0.0',
    port: 4173,
    // Enable HTTPS on Vite dev server if SSL certificates are available
    https: sslExists ? {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    } : false,
    proxy: {
      '/socket.io': {
        target: getBackendUrl(),
        ws: true,
        secure: false, // Allow self-signed certificates in development
        changeOrigin: true
      }
    }
  }
});
