#!/usr/bin/env bash
# exit on error
set -o errexit

# Install dependencies
npm install

# Uncomment this line if you need to build your project
# npm run build

# Ensure the Puppeteer cache directory exists
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

# Install Puppeteer and download Chrome
npx puppeteer browsers install chrome

# Store/pull Puppeteer cache with build cache
if [[ -d /opt/render/project/src/.cache/puppeteer/chrome/ ]]; then # Cambié la condición para verificar la existencia del destino de caché
    echo "...Copying Puppeteer Cache from Build Cache"
    # Copying from the actual path where Puppeteer stores its Chrome binary
    # Nota: Render recomienda usar $PUPPETEER_CACHE_DIR como la fuente de la verdad
    cp -R /opt/render/project/src/.cache/puppeteer/chrome/* $PUPPETEER_CACHE_DIR/
else
    echo "...Storing Puppeteer Cache in Build Cache"
    # AÑADIR ESTA LÍNEA CLAVE: Crear el directorio de destino antes de copiar
    mkdir -p /opt/render/project/src/.cache/puppeteer/chrome/
    cp -R $PUPPETEER_CACHE_DIR/* /opt/render/project/src/.cache/puppeteer/chrome/
fi