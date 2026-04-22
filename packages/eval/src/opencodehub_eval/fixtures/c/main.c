#include <stdio.h>
#include "auth.h"

int main(void) {
    auth_register("alice@example.com", "hunter2");
    if (auth_login("alice@example.com", "hunter2")) {
        printf("login ok\n");
    }
    auth_logout("alice@example.com");
    return 0;
}
