FOSS E2E Playwright Test Plan

E2E Testing for FOSS Platform (SSO + Multi-App + Cross-Browser Validation using Playwright)

Objective:
Implement end-to-end (E2E) automated tests using Playwright to validate SSO authentication, multi-app session sharing, access control, and admin security across all 4 apps on https://foss.arbisoft.com/.

Scope of Work:

1. SSO Authentication Flow
- Perform login via SSO on the FOSS platform.
- Verify single login session shared across all 4 apps.
- Ensure no re-authentication required when switching apps.
- Validate session persistence using cookies/local storage.

2. Multi-App Validation
- Identify and test all 4 applications.
- Navigate key pages in each app.
- Verify authenticated state across apps.
- Ensure consistent user experience.

3. Access Control & Security Validation
- Attempt direct access to blocked/protected URLs.
- Verify proper denial (redirect/403/etc).
- Ensure no bypass possible.

4. Admin / God-Mode Verification
- Identify admin routes.
- Ensure proper authorization required.
- Ensure no SSO bypass or proxy exposure.

5. Session Lifecycle
- Logout from one app should logout all apps.
- Verify session invalidation.
- Verify no access after logout.

6. Cross-Browser Testing
- Run tests on Chromium, Firefox, Safari.
- Ensure consistent SSO behavior.
- Validate cookies/session handling across browsers.

Technical Requirements:
- Use Playwright
- Single browser context for session validation
- Use storageState if needed
- Capture screenshots on failure

Deliverables:
- Playwright test suite
- CI-ready configuration
- Documentation
- Test reports/logs

Acceptance Criteria:
- SSO works across all apps
- Session shared correctly
- Access control enforced
- Admin routes protected
- Logout works globally
- Cross-browser compatibility ensured