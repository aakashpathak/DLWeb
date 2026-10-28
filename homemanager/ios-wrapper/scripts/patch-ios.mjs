// Makes the generated Xcode project ready for push + TestFlight (idempotent):
//  - Push Notifications entitlement (production, which TestFlight uses)
//  - AppDelegate forwards the push token to Capacitor
//  - Info.plist: no export-compliance question on every TestFlight upload
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', 'ios', 'App');

const ent = join(app, 'App', 'App.entitlements');
if (!existsSync(ent)) {
  writeFileSync(ent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyLists-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>aps-environment</key>
\t<string>production</string>
</dict>
</plist>
`);
}
const pbx = join(app, 'App.xcodeproj', 'project.pbxproj');
let p = readFileSync(pbx, 'utf8');
if (!p.includes('CODE_SIGN_ENTITLEMENTS')) {
  p = p.replace(/(\n(\s*)PRODUCT_BUNDLE_IDENTIFIER = [^;]+;)/g, '\n$2CODE_SIGN_ENTITLEMENTS = App/App.entitlements;$1');
  writeFileSync(pbx, p);
}

const delegate = join(app, 'App', 'AppDelegate.swift');
let d = readFileSync(delegate, 'utf8');
if (!d.includes('capacitorDidRegisterForRemoteNotifications')) {
  const hooks = `
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
}
`;
  d = d.replace(/}\s*$/, hooks);
  writeFileSync(delegate, d);
}

const plist = join(app, 'App', 'Info.plist');
let s = readFileSync(plist, 'utf8');
if (!s.includes('<key>ITSAppUsesNonExemptEncryption</key>')) {
  s = s.replace('</dict>\n</plist>', '\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n</dict>\n</plist>');
  writeFileSync(plist, s);
}
console.log('iOS project patched: push entitlement, AppDelegate push hooks, export compliance');
