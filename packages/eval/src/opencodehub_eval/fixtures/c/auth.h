#ifndef AUTH_H
#define AUTH_H

#include <stddef.h>

typedef struct User {
    char email[64];
    char password_hash[64];
} User;

int auth_register(const char *email, const char *password);
int auth_login(const char *email, const char *password);
void auth_logout(const char *email);

#endif
