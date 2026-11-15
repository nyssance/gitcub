#import <Foundation/Foundation.h>
#import <Security/Security.h>

// Read only, called exclusively during an explicit user-initiated import.
// macOS may authorize this one-time read; background discovery never calls it.
int gitcub_read_desktop_credential(const char *service, const char *account,
                                  unsigned char *buffer, size_t capacity, size_t *length) {
    @autoreleasepool {
        *length = 0;
        NSString *serviceName = [NSString stringWithUTF8String:service];
        NSString *accountName = [NSString stringWithUTF8String:account];
        if (!serviceName || !accountName) return errSecParam;
        NSDictionary *query = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: serviceName,
            (__bridge id)kSecAttrAccount: accountName,
            (__bridge id)kSecReturnData: @YES,
            (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne
        };
        CFTypeRef result = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
        if (status == errSecSuccess) {
            if (!result || CFGetTypeID(result) != CFDataGetTypeID()) {
                status = errSecDecode;
            } else {
                CFDataRef data = (CFDataRef)result;
                CFIndex count = CFDataGetLength(data);
                if (count < 0 || (size_t)count > capacity) status = errSecBufferTooSmall;
                else {
                    memcpy(buffer, CFDataGetBytePtr(data), (size_t)count);
                    *length = (size_t)count;
                }
            }
        }
        if (result) CFRelease(result);
        return status;
    }
}
