FROM node:20-alpine
WORKDIR /app
COPY stremio-addon-test/package.json ./
RUN npm install --omit=dev
COPY stremio-addon-test/ ./
EXPOSE 10000
CMD ["node", "server.js"]
