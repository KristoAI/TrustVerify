import bodyParser          from 'body-parser';
import cookieParser        from 'cookie-parser';
import express             from 'express';
import session             from 'express-session';
import http                from 'http';
import morgan              from 'morgan';
import path                from 'path';
import favicon             from 'serve-favicon';
import {config}            from './config';
import {AvsRandom}         from "./lib/random";
import {AvsStorageSession} from "./storage/session";

import * as indexRoute  from './route';
import * as resultRoute from './route/result';
import * as tokenRoute  from './route/token';

const app = express();
declare module 'express-session' {
	export interface SessionData {
		[key: string]: any;
	}
}

const avsStorageInstance = new AvsStorageSession();

app.use(bodyParser.urlencoded({extended: false}));
app.use(cookieParser());
app.use(session({
	secret           : AvsRandom.generateRandomString(),
	resave           : false,
	saveUninitialized: true,
	cookie           : {
		secure: false
	}
}));
app.use(express.static('app/frontend'));
app.use(favicon(path.join(__dirname, '../frontend/static', 'favicon.ico')))

const server = new http.Server(app);

app.use(morgan('combined'));

app.set('views', config.htmlFilePath);
app.set('twig options', {
	allowAsync      : true,
	strict_variables: false
});
app.locals.cacheBuster = config.cacheBuster;
app.locals.nodeEnv     = process.env.NODE_ENV || 'not defined';
tokenRoute.load(app, avsStorageInstance);
resultRoute.load(app, avsStorageInstance);
indexRoute.load(app, avsStorageInstance);

server.listen(config.httpServerPort, config.httpServerHost, () => {
	console.log('http server started on: ' + config.httpServerProtocol + '://' + config.httpServerHost + ':' + config.httpServerPort);
});
