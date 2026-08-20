const URL = require("url");
const fs   = require('node:fs');
const path = require('path');

function load(app, appConfig) {

	app.use((req, res, next) => {
		next();
	});

	app.get('/', (req, res) => {

		res.render('index.twig', {
			exampleBaseUrl: appConfig.exampleBaseUrl,
		});

	});

}

exports.load = load;
