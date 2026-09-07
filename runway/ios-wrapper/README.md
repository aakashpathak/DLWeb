# Runway iOS shell

Capacitor project that bundles the Runway web app (`../`) into a native iOS app and adds
native speech recognition and scheduled notifications. Full step-by-step in `../SETUP.md`, Part 2.

```bash
npm install
npm run setup     # copies the web app in, creates the Xcode project, patches permissions, generates icons
npm run open      # opens Xcode
npm run update    # after any change to the web app: re-copy + sync
```
