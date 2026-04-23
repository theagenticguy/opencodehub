<?php
require_once 'Auth.php';

use AuthFx\Auth;

$auth = new Auth();
$auth->register("alice@example.com", "hunter2");
$result = $auth->login("alice@example.com", "hunter2");
if ($result !== null) {
    echo "login ok\n";
}
$auth->logout("alice@example.com");
