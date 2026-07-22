FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

ENV PORT=3000
EXPOSE 3000

USER node
CMD ["npm", "start"]