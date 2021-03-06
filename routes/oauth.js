/**
 * oauth2js (https://github.com/ni-c/oauth2js)
 *
 * @file routes/oauth.js
 * @brief OAuth routes
 * @author Willi Thiel (ni-c@ni-c.de)
 *
 * <pre>
 * Client table structure: 
 * {
 *   "_id" : ObjectId("01234567890ab"),
 *   "redirect_uri" : "http://client.example.com",
 *   "name" : "Example Client",
 *   "secret" : "jdadDsaf7SAdZfha7sd"
 * }
 * 
 * User table structure:
 * {
 *   "_id" : ObjectId("01234567890ab"),
 *   "email" : "mail@example.com",
 *   "password" : "c2d3f68aacb4e5fc87191caba9d42d148cd60181cdd2c999c6aac4fa28cefb0b",
 * }
 * </pre>
 */
if (typeof define !== 'function') {
  var define = require('amdefine')(module);
}

define([ 'crypto', 'mongodb', 'moment' ], function(crypto, mongodb, moment) {

  var oauth = {};

  var BSON = mongodb.BSONPure;

  /**
   * Send an error to the client
   * 
   * @param http_status The http status code to send
   * @param error The error to send
   * @param error_description The error description to send
   * @param res Response object
   */
  sendError = function(res, http_status, error, error_description) {
    res.set('WWW-Authenticate', 'Bearer realm="oauth2js", error="' + error + '", error_description="' + error_description + '"');
    res.json(http_status, {
      error: error,
      error_description: error_description
    });
  };

  /**
   * Create OAuth token from code
   * 
   * POST /token - RFC 6749 - 4.1.3.
   * @link http://tools.ietf.org/html/rfc6749#section-4.1.3
   * 
   * @param req The request
   * @param res The response
   */
  oauth.token = function(req, res) {
    var grant_type = req.body.grant_type || null;
    var code = req.body.code || null;
    var redirect_uri = req.body.redirect_uri || null;
    var client_id = req.body.client_id || null;

    // Set header
    res.set('Content-Type', 'application/json');
    res.charset = 'utf-8';

    // Missing param => Invalid request
    if ((!grant_type) || (!code) || (!redirect_uri) || (!client_id)) {
      return sendError(res, 400, 'invalid_request', 'The request is missing a required parameter.');
    }

    // Check for valid client_id
    if ((client_id.length != 12) && (client_id.length != 24)) {
      return sendError(res, 400, 'invalid_request', 'client_id must be a single String of 12 bytes or a string of 24 hex characters.');
    }

    // Grant type not supported
    if (grant_type != 'authorization_code') {
      return sendError(res, 400, 'unsupported_grant_type', 'The authorization grant type is not supported by the authorization server.');
    }

    req.app.get('db').collection('Client', function(err, c) {
      c.find({
        '_id': new BSON.ObjectID(client_id)
      }).toArray(function(err, r) {

        // Client not found
        if (r.length == 0) {
          return sendError(res, 401, 'invalid_client', 'Client authentication failed, unknown client.');
        } else {
          r = r.pop();

          // Redirect URI does not match
          if (r.redirect_uri != redirect_uri) {
            return sendError(res, 400, 'invalid_grant', 'Redirection URI does not match.');
          }

          req.app.get('db').collection('Token', function(err, t) {
            t.find({
              'token': code,
              'type': 'authorization_token',
              'valid': true
            }).toArray(function(err, r) {

              // Authorization code not found
              if (r.length != 1) {
                return sendError(res, 400, 'invalid_grant', 'Invalid authorization code');
              }

              var authcode = r[0];

              // Authorization code expired or already used
              if ((moment(authcode.expires_in) < moment()) || (authcode.last_access != null)) {
                return sendError(res, 400, 'invalid_grant', 'Authorization code expired');
              }

              authcode.last_access = moment();
              t.save(authcode, function(err, r) {
                // Generate access token
                var token_expire_time = req.app.get('oauth').token_expire_time;
                crypto.randomBytes(24, function(ex, buf) {
                  var token = {
                    token: buf.toString('base64'),
                    user_id: authcode.user_id,
                    client_id: authcode.client_id,
                    created: moment().format(),
                    expires_in: moment().add('seconds', token_expire_time).format(),
                    type: "access_token",
                    scopeList: authcode.scopeList,
                    last_access: null,
                    valid: true
                  };

                  // Save token to database
                  t.save(token, function(err, r) {

                    var response = req.body;
                    delete response.grant_type;
                    delete response.redirect_uri;
                    delete response.client_id;
                    delete response.client_secret;
                    delete response.type;
                    delete response.code;
                    response.access_token = token.token;
                    response.token_type = 'bearer';
                    response.expires_in = token_expire_time;

                    // Send response
                    res.json(200, response);
                  });
                });
              });
            });
          });
        }
      });
    });
  };

  /**
   * Create OAuth token from code
   * 
   * GET /authorize - RFC 6749 - 4.2.1.
   * @link http://tools.ietf.org/html/rfc6749#section-4.2.1
   * 
   * @param req The request
   * @param res The response
   */
  oauth.authorize = function(req, res) {

    var response_type = req.query.response_type || null;
    var client_id = req.query.client_id || null;
    var redirect_uri = req.query.redirect_uri || null;
    var scope = req.query.scope || null;
    var state = req.query.state || null;

    res.set('Content-Type', 'application/json');
    res.charset = 'utf-8';

    // Missing param => Invalid request
    if ((!response_type) || (!client_id)) {
      return sendError(res, 400, 'invalid_request', 'The request is missing a required parameter.');
    }

    // Check for valid client_id
    if ((client_id.length != 12) && (client_id.length != 24)) {
      return sendError(res, 400, 'invalid_request', 'client_id must be a single String of 12 bytes or a string of 24 hex characters.');
    }

    // No user logged in
    if ((!req.session.user) && (response_type == 'token')) {
      req.session.redirectto = req.url;
      return res.redirect('/login');
    }

    req.app.get('db').collection('Client', function(err, c) {
      c.find({
        '_id': new BSON.ObjectID(client_id)
      }).toArray(function(err, r) {

        // Client not found
        if (r.length == 0) {
          if (response_type != 'token') {
            return sendError(res, 400, 'unsupported_response_type', 'The response type is not supported by the authorization server.');
          } else {
            return sendError(res, 401, 'access_denied', 'The resource owner or authorization server denied the request.');
          }
        } else {
          r = r.pop();

          // Redirect URI does not match
          if ((redirect_uri) && (r.redirect_uri != redirect_uri)) {
            return sendError(res, 401, 'access_denied', 'Redirection URI does not match.');
          }

          // No redirect URI
          if ((!redirect_uri) && (!r.redirect_uri)) {
            return sendError(res, 400, 'invalid_request', 'No redirection URI provided.');
          }

          // Only response type token is supported
          if (response_type != 'token') {
            redirect_uri += '?error=unsupported_response_type';
            if (state) {
              redirect_uri += '&state=' + state;
            }
            return res.redirect(302, redirect_uri);
          }

          // Generate token
          var token_expire_time = req.app.get('oauth').token_expire_time;
          crypto.randomBytes(24, function(ex, buf) {
            var token = {
              token: buf.toString('base64'),
              user_id: req.session.user._id,
              client_id: client_id,
              created: moment().format(),
              expires_in: moment().add('seconds', token_expire_time).format(),
              type: "authorization_token",
              scopeList: [],
              last_access: null,
              valid: true
            };

            // Save scope
            if (scope) {
              token.scopeList = scope.split(' ');
            }

            // Save token to database
            req.app.get('db').collection('Token', function(err, t) {
              t.save(token, function(err, r) {

                // Redirect to Client
                redirect_uri = redirect_uri + '?access_token=' + token.token + '&token_type=bearer&expires_in=' + token_expire_time + (state ? '&state=' + state : '');
                res.redirect(302, redirect_uri);
              });
            });
          });
        }
      });
    });
  };

  /**
   * Verify the access token
   * 
   * GET /Verify
   * 
   * @param req The request
   * @param res The response
   */
  oauth.verify = function(req, res) {
    var access_token = '';

    // Look for authorization header
    if (req.headers.authorization) {
      var authorization = req.headers.authorization.split(' ');
      if ((authorization.length == 2) && (authorization[0] == 'Bearer')) {
        access_token = authorization[1];
      }
    }

    if ((access_token == '') && (req.query.access_token)) {
      access_token = req.query.access_token;
    }

    req.app.get('db').collection('Token', function(err, t) {
      t.find({
        'token': access_token,
        'type': 'access_token',
        'valid': true
      }).toArray(function(err, r) {
        if ((!err) && (r.length == 1) && (moment(r[0].expires_in)) > moment()) {
          var token_data = r[0];
          r[0].last_access = moment().format();
          t.save(r[0], function(err, r) {
            return res.json(200, token_data);
          });
        } else {
          return res.json(401, {
            'error': '401',
            'error_description': 'Unauthorized'
          });
        }
      });
    });
  };

  return oauth;
});