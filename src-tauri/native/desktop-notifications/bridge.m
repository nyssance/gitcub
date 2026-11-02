// Native ABI adaptation only. Notification behavior stays in Desktop's unchanged manager.
#import "GHDesktopNotificationsManager.h"
#import <UserNotifications/UserNotifications.h>
typedef void (*ResultCallback)(void *, const char *, const char *);
typedef void (*EventCallback)(const char *, const char *, const char *);
static GHDesktopNotificationsManager *manager;
bool gitcub_notifications_initialize(EventCallback callback) {
 @autoreleasepool {
  if (manager) return true;
  // UNUserNotificationCenter raises an Objective-C exception for an unbundled
  // development executable. Never let that unwind across the Rust ABI.
  if (![NSBundle.mainBundle.bundlePath hasSuffix:@".app"]) return false;
  @try {
  manager = [GHDesktopNotificationsManager new];
  manager.completionHandler = ^(NSString *event, NSString *identifier, NSDictionary *userInfo, dispatch_block_t completion) {
   NSData *data = [NSJSONSerialization dataWithJSONObject:userInfo ?: @{} options:0 error:nil];
   NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
   callback(event.UTF8String, identifier.UTF8String, json.UTF8String ?: "{}");
   completion();
  };
  return true;
  } @catch (NSException *exception) {
   NSLog(@"Unable to initialize notifications: %@", exception.reason);
   manager = nil;
   return false;
  }
 }
}
void gitcub_notifications_permission(void *context, ResultCallback callback) {
 @autoreleasepool {
  if (!manager) {callback(context,"Notifications not initialized",NULL);return;}
  [manager getNotificationSettingsWithCompletionHandler:^(NSString *permission){callback(context,NULL,permission.UTF8String);}];
 }
}
void gitcub_notifications_request(void *context, ResultCallback callback) {
 @autoreleasepool {
  if (!manager) {callback(context,"Notifications not initialized",NULL);return;}
  [manager requestAuthorizationWithCompletionHandler:^(BOOL granted,NSError *error){callback(context,error.localizedDescription.UTF8String,granted?"true":"false");}];
 }
}
void gitcub_notifications_show(const char *identifier,const char *title,const char *body,const char *json,void *context,ResultCallback callback) {
 @autoreleasepool {
  if (!manager) {callback(context,"Notifications not initialized",NULL);return;}
  NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *info = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  [manager showNotificationWithIdentifier:[NSString stringWithUTF8String:identifier]
    title:[NSString stringWithUTF8String:title] body:[NSString stringWithUTF8String:body] userInfo:info
    completionHandler:^(NSError *error){callback(context,error.localizedDescription.UTF8String,NULL);}];
 }
}
void gitcub_notifications_close(const char *identifier) {
 @autoreleasepool { [manager removePendingNotificationRequestsWithIdentifiers:@[[NSString stringWithUTF8String:identifier]]]; }
}
void gitcub_notifications_terminate(void) {
 @autoreleasepool {
  if (!manager) return;
  [UNUserNotificationCenter currentNotificationCenter].delegate=nil;
  manager.completionHandler=nil;
  manager=nil;
 }
}
