/**
 * @openapi
 * /api/auth/authorize:
 *   post:
 *     tags: [Authentication]
 *     summary: Start the authorization-code flow with credentials (first-party clients)
 *     description: >
 *       Verifies the credentials and returns a single-use, PKCE-bound
 *       authorization code. NO tokens are returned here — exchange the code at
 *       /api/auth/token with the matching code_verifier.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, code_challenge]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *               code_challenge: { type: string, description: 'BASE64URL(SHA256(code_verifier))' }
 *               code_challenge_method: { type: string, enum: [S256], default: S256 }
 *               client_id: { type: string, example: aritii-eshop }
 *               scope: { type: string, example: 'openid profile email' }
 *               state: { type: string }
 *     responses:
 *       200:
 *         description: Authorization code issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 code: { type: string }
 *                 state: { type: string, nullable: true }
 *                 expires_in: { type: integer, example: 300 }
 *       400: { description: invalid_request (PKCE parameters missing or not S256) }
 *       401: { description: access_denied (invalid credentials) }
 *
 * @openapi
 * /api/auth/authorize:
 *   get:
 *     tags: [Authentication]
 *     summary: Authorization endpoint for an already-authenticated principal (consent/step-up)
 *     parameters:
 *       - { in: query, name: response_type, required: true, schema: { type: string, enum: [code] } }
 *       - { in: query, name: code_challenge, required: true, schema: { type: string } }
 *       - { in: query, name: code_challenge_method, required: true, schema: { type: string, enum: [S256] } }
 *       - { in: query, name: client_id, schema: { type: string } }
 *       - { in: query, name: redirect_uri, schema: { type: string, format: uri } }
 *       - { in: query, name: scope, schema: { type: string } }
 *       - { in: query, name: state, schema: { type: string } }
 *     responses:
 *       200: { description: Authorization code issued }
 *       401: { description: login_required / invalid_token }
 *
 * @openapi
 * /api/auth/register:
 *   post:
 *     tags: [Authentication]
 *     summary: Create an account and return a PKCE-bound authorization code
 *     description: No tokens are issued here; complete the flow at /api/auth/token.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password, code_challenge]
 *             properties:
 *               name: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string, format: password, minLength: 8 }
 *               code_challenge: { type: string }
 *               code_challenge_method: { type: string, enum: [S256] }
 *               client_id: { type: string }
 *     responses:
 *       201: { description: Account created and authorization code issued }
 *       409: { description: user already exists }
 *
 * @openapi
 * /api/auth/token:
 *   post:
 *     tags: [Authentication]
 *     summary: Token endpoint — the ONLY place tokens are issued
 *     description: >
 *       grant_type=authorization_code exchanges a PKCE-bound single-use code for
 *       a short-lived RS256 access token, an ID token and a rotating refresh
 *       token. grant_type=refresh_token rotates the session (the presented
 *       refresh token is invalidated; reuse revokes the whole token family).
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [grant_type]
 *             properties:
 *               grant_type: { type: string, enum: [authorization_code, refresh_token] }
 *               code: { type: string, description: 'required for authorization_code' }
 *               code_verifier: { type: string, description: 'required for authorization_code' }
 *               redirect_uri: { type: string, description: 'must match the value bound to the code, if any' }
 *               refresh_token: { type: string, description: 'required for refresh_token' }
 *               client_id: { type: string }
 *     responses:
 *       200:
 *         description: Token pair issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 access_token: { type: string }
 *                 id_token: { type: string }
 *                 refresh_token: { type: string }
 *                 token_type: { type: string, example: Bearer }
 *                 expires_in: { type: integer, example: 600 }
 *                 scope: { type: string }
 *       400: { description: invalid_grant / unsupported_grant_type }
 *
 * @openapi
 * /api/auth/refresh:
 *   post:
 *     tags: [Authentication]
 *     summary: Alias of the token endpoint for grant_type=refresh_token
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refresh_token]
 *             properties:
 *               refresh_token: { type: string }
 *     responses:
 *       200: { description: Rotated token pair }
 *       401: { description: invalid refresh token or reuse detected }
 *
 * @openapi
 * /api/auth/revoke:
 *   post:
 *     tags: [Authentication]
 *     summary: Revoke a refresh token (RFC 7009)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token: { type: string }
 *     responses:
 *       200: { description: Revoked (always 200 per RFC 7009) }
 *
 * @openapi
 * /api/user/getuser:
 *   get:
 *     tags: [Identity]
 *     summary: Current authenticated user (OIDC userinfo equivalent)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: User profile }
 *       401: { description: Missing or invalid access token }
 *
 * @openapi
 * /api/user/logout:
 *   post:
 *     tags: [Identity]
 *     summary: Revoke the session's refresh token
 *     security: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refresh_token: { type: string }
 *     responses:
 *       200: { description: Logged out }
 *
 * @openapi
 * /api/admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List users (admin console)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, default: 20 } }
 *       - { in: query, name: search, schema: { type: string } }
 *     responses:
 *       200: { description: Paged users }
 *       403: { description: ADMIN role required }
 *
 * @openapi
 * /api/product/get-all-products:
 *   get:
 *     tags: [Commerce]
 *     summary: Public product listing
 *     security: []
 *     responses:
 *       200: { description: Products }
 *
 * @openapi
 * /api/delivery/actor:
 *   get:
 *     tags: [Delivery]
 *     summary: List riders/actors (admin console)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Actors }
 *       403: { description: ADMIN role required }
 *
 * @openapi
 * /.well-known/openid-configuration:
 *   get:
 *     tags: [OIDC]
 *     summary: OIDC discovery document
 *     security: []
 *     responses:
 *       200: { description: Provider metadata }
 *
 * @openapi
 * /api/auth/.well-known/jwks.json:
 *   get:
 *     tags: [OIDC]
 *     summary: JWKS — public keys used to verify RS256 access tokens
 *     security: []
 *     responses:
 *       200: { description: JSON Web Key Set }
 */
