# Dockerfile
FROM node:20-alpine

# set working directory
WORKDIR /usr/src/app

# copy package.json and install deps
COPY package*.json ./
RUN npm install --production

# copy app code
COPY . .

# expose port
EXPOSE 3000

# start app
CMD ["node", "server.js"]
