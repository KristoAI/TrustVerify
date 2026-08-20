<?php

require_once 'config.php';

global $config;

?><html lang="en">
<head>
	<title>Age verification implementation demo</title>
	<link rel="stylesheet" href="<?php echo $config['exampleBaseUrl']; ?>/redirect/css/style.css"/>
</head>
<body>
	<div class="container">
		<img class="logo" src="<?php echo $config['exampleBaseUrl']; ?>/redirect/img/logo.svg"/>
		<h1>Age verification implementation demo</h1>
		<p>Below you can find a basic implementation of both type of age verification implementation flows.</p>
		<p>Please check the <strong>log/callback.log</strong> file in the root of the project for callback results.</p>
		<p>
			<a class="button" href="<?php echo $config['exampleBaseUrl']; ?>/redirect/">Redirect logic</a>
			<a class="button" href="<?php echo $config['exampleBaseUrl']; ?>/iframe/">Iframe overlay logic</a>
		</p>
	</div>
</body>
</html>
