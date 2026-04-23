#include "auth.h"
#include <stdio.h>
#include <string.h>

#define MAX_USERS 16

static User g_users[MAX_USERS];
static size_t g_user_count = 0;

static void _hash(const char *raw, char *out) {
    snprintf(out, 64, "sha256:%zu:%s", strlen(raw), raw);
}

int auth_register(const char *email, const char *password) {
    if (g_user_count >= MAX_USERS) return -1;
    User *u = &g_users[g_user_count++];
    strncpy(u->email, email, sizeof(u->email) - 1);
    _hash(password, u->password_hash);
    return 0;
}

int auth_login(const char *email, const char *password) {
    char hashed[64];
    _hash(password, hashed);
    for (size_t i = 0; i < g_user_count; i++) {
        if (strcmp(g_users[i].email, email) == 0 &&
            strcmp(g_users[i].password_hash, hashed) == 0) {
            return 1;
        }
    }
    return 0;
}

void auth_logout(const char *email) {
    (void)email;
}
