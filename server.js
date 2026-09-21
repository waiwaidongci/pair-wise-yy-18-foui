'use strict';

const { createApp, config } = require('./src/app');

const PORT = process.env.PORT || config.port;
const { app } = createApp();

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});
