#!/usr/bin/env bash
# exit on error
set -o errexit

# --- 1. INSTALACIÓN DE DEPENDENCIAS Y CHROME ---

echo "Instalando dependencias de Node.js..."
npm install

# 1.1 Asegurar que el directorio de caché de Puppeteer existe
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

# 1.2 Instalar Puppeteer y descargar Chrome
echo "Descargando binario de Chrome con Puppeteer..."
npx puppeteer browsers install chrome

# --- 2. ENCONTRAR Y GUARDAR LA RUTA DEL EJECUTABLE ---

# 2.1 Buscar la ruta exacta del binario 'chrome' dentro de la caché.
# Usamos 'find' para localizar el archivo y 'head -n 1' para tomar la primera coincidencia.
# Buscar la ruta exacta del binario 'chrome' dentro de la caché.
export CHROME_BIN_PATH=$(find $PUPPETEER_CACHE_DIR -name 'chrome' -type f | head -n 1)

# *** ¡NUEVA LÍNEA CLAVE! ***
# Imprimir la variable para que el Start Command pueda capturarla
echo "CHROME_PATH_VALUE=$CHROME_BIN_PATH"
# 2.2 Exportar la variable CHROME_PATH a un archivo para que el Start Command pueda leerlo.
echo "CHROME_PATH=$CHROME_BIN_PATH" > /tmp/.puppeteer-path
echo "Ruta de Chrome guardada en /tmp: $CHROME_BIN_PATH"
# --- 3. GESTIÓN DE LA CACHÉ DE BUILD ---

# Definir la ubicación de la caché de build de Render
RENDER_BUILD_CACHE_PATH=/opt/render/project/src/.cache/puppeteer/chrome/
mkdir -p $RENDER_BUILD_CACHE_PATH # Asegurar que el directorio destino existe

# Comprobación de existencia (simplificada):
if [[ -d $PUPPETEER_CACHE_DIR ]]; then
    echo "...Almacenando la caché de Puppeteer en la caché de Build de Render..."
    # Copiar el contenido del directorio de la versión (ej: linux-143...)
    cp -R $PUPPETEER_CACHE_DIR/* $RENDER_BUILD_CACHE_PATH/
fi