#include <windows.h>
#include <wincred.h>
#include <stdlib.h>
#include <string.h>

// Desktop uses keytar 7.8: target = service + '/' + account, blob = UTF-8.
// https://github.com/atom/node-keytar/blob/v7.8.0/src/keytar_win.cc
// Read the exact target only; never enumerate, write, or show credential UI.
int gitcub_read_desktop_credential(const char *service, const char *account,
                                  unsigned char *buffer, size_t capacity, size_t *length) {
    *length = 0;
    size_t service_length = strlen(service), account_length = strlen(account);
    if (service_length > 32768 || account_length > 32768) return ERROR_INVALID_PARAMETER;
    size_t size = service_length + account_length + 2;
    char *target = malloc(size);
    if (!target) return ERROR_NOT_ENOUGH_MEMORY;
    memcpy(target, service, service_length);
    target[service_length] = '/';
    memcpy(target + service_length + 1, account, account_length + 1);
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, target, -1, NULL, 0);
    if (!count) { free(target); return ERROR_NO_UNICODE_TRANSLATION; }
    WCHAR *wide = malloc((size_t)count * sizeof(WCHAR));
    if (!wide) { free(target); return ERROR_NOT_ENOUGH_MEMORY; }
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, target, -1, wide, count);
    free(target);
    PCREDENTIALW credential = NULL;
    BOOL found = CredReadW(wide, CRED_TYPE_GENERIC, 0, &credential);
    DWORD status = found ? ERROR_SUCCESS : GetLastError();
    free(wide);
    if (!found) return (int)status;
    if (credential->CredentialBlobSize > capacity) status = ERROR_INSUFFICIENT_BUFFER;
    else if (credential->CredentialBlobSize && !credential->CredentialBlob) status = ERROR_INVALID_DATA;
    else {
        if (credential->CredentialBlobSize) memcpy(buffer, credential->CredentialBlob, credential->CredentialBlobSize);
        *length = credential->CredentialBlobSize;
    }
    CredFree(credential);
    return (int)status;
}
