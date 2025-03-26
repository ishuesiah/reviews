// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mysql = require('mysql2/promise'); // For MySQL pool
const fetch = require('node-fetch'); // Install with: npm install node-fetch
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3306;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN || 'hemlock-oak.myshopify.com';


// Initialize MySQL pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQL_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000, // Increased to 30 seconds
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  // Add connection retry settings
  acquireTimeout: 30000,
  reconnect: true
});

// Add these after pool creation
pool.on('connection', (connection) => {
  console.log('New DB connection established');
});

pool.on('acquire', (connection) => {
  console.log('Connection %d acquired', connection.threadId);
});

pool.on('release', (connection) => {
  console.log('Connection %d released', connection.threadId);
});

pool.on('error', (err) => {
  console.error('MySQL pool error:', err);
  // Implement retry logic here if needed
});

// Enable CORS for your Shopify store domain
app.use(cors({
  origin: process.env.SHOPIFY_STORE_URL || 'https://hemlock-oak.myshopify.com',
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// --- Existing endpoints for Judge.me reviews ---

// Endpoint to submit a review
app.post('/api/submit-review', async (req, res) => {
  try {
    const reviewData = req.body;
    // Attach required Judge.me parameters
    reviewData.api_token = process.env.JUDGEME_API_TOKEN;
    reviewData.shop_domain = process.env.SHOP_DOMAIN || 'hemlock-oak.myshopify.com';
    reviewData.platform = process.env.PLATFORM || 'shopify';

    // Forward the review to Judge.me
    const response = await axios.post('https://judge.me/api/v1/reviews', reviewData, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    return res.json(response.data);
  } catch (error) {
    console.error('Error submitting review:', error.message);
    return res.status(500).json({ error: 'Failed to submit review', details: error.message });
  }
});

// Check if running
app.get('/', (req, res) => {
  res.send('Review Proxy Server is up and running!');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
});

// Endpoint to fetch customer reviews
app.get('/api/customer-reviews', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Customer email is required' });
    }
    
    console.log(`Fetching reviews for customer: ${email}`);
    
    const reviewsResponse = await axios.get('https://judge.me/api/v1/reviews', {
      params: {
        api_token: process.env.JUDGEME_API_TOKEN,
        shop_domain: process.env.SHOP_DOMAIN || 'hemlock-oak.myshopify.com',
        platform: process.env.PLATFORM || 'shopify',
        reviewer_email: email
      }
    });
    
    return res.json(reviewsResponse.data);
  } catch (error) {
    console.error('Error fetching reviews:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    return res.status(500).json({ 
      error: 'Failed to fetch reviews',
      details: error.message
    });
  }
});

/********************************************************************
 * POST /api/referral/redeem
 * Body: {
 *   "email": "user@example.com",
 *   "pointsToRedeem": 10,
 *   "redeemType": "discount" or "gift_card",
 *   "redeemValue": "10OFF" // e.g. $ amount, % off, free shipping, etc.
 * }
 ********************************************************************/

// ...
app.post('/api/referral/redeem', async (req, res) => {
  let connection;
  try {
    // Get connection from pool
    connection = await pool.getConnection();
    console.log("DEBUG: Acquired connection from pool");
    
    // Log the incoming request body for debugging
    console.log("DEBUG: Incoming redeem request body:", req.body);

    const { email, pointsToRedeem, redeemType, redeemValue } = req.body;

    // Check for missing parameters
    if (!email || !pointsToRedeem) {
      console.log("DEBUG: Missing email or pointsToRedeem");
      return res.status(400).json({ error: 'Missing email or pointsToRedeem.' });
    }
    console.log(`DEBUG: Attempting to redeem ${pointsToRedeem} points for email=${email}`);

    // 1) Find user in MySQL using the pool
    console.log("DEBUG: Running query: SELECT * FROM users WHERE email = ?", email);
    const [rows] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
    console.log("DEBUG: Query result rows:", rows);

    if (rows.length === 0) {
      console.log(`DEBUG: No user found for email=${email}`);
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = rows[0];
    console.log("DEBUG: Found user:", user);

    // 2) Check if the user has enough points
    console.log(`DEBUG: User has ${user.points} points. Need ${pointsToRedeem}.`);
    if (user.points < pointsToRedeem) {
      console.log("DEBUG: Not enough points to redeem.");
      return res.status(400).json({ error: 'Not enough points to redeem.' });
    }

    // 3) Subtract redeemed points from the user's balance
    const newPoints = user.points - pointsToRedeem;
    console.log(`DEBUG: Subtracting points. New points balance will be ${newPoints}`);
    await connection.execute('UPDATE users SET points = ? WHERE user_id = ?', [newPoints, user.user_id]);

    // 4) Log the redemption
    const insertActionSql = `
      INSERT INTO user_actions (user_id, action_type, points_awarded)
      VALUES (?, ?, ?)
    `;
    console.log(`DEBUG: Inserting user action: redeem-${redeemType} for user_id=${user.user_id}, points=-${pointsToRedeem}`);
    await connection.execute(insertActionSql, [user.user_id, `redeem-${redeemType}`, -pointsToRedeem]);

    // 5) Create a discount code (or gift card) via Shopify Admin API
    let generatedCode = '';
    if (redeemType === 'discount') {
      console.log(`DEBUG: Creating discount code for redeemValue=${redeemValue}`);
      generatedCode = await createShopifyDiscountCode(redeemValue);
    } else if (redeemType === 'gift_card') {
      console.log(`DEBUG: Creating gift card for redeemValue=${redeemValue}`);
      generatedCode = await createShopifyGiftCard(redeemValue); // Implement if needed.
    } else {
      console.log(`DEBUG: Unrecognized redeemType, defaulting to discount code for redeemValue=${redeemValue}`);
      generatedCode = await createShopifyDiscountCode(redeemValue);
    }
    console.log(`DEBUG: Discount code generated: ${generatedCode}`);

    // 6) Save the generated discount code to the new column in the users table.
    // Ensure that your users table has a column called "discount_code" (adjust column name if different)
    console.log(`DEBUG: Saving discount code ${generatedCode} to user_id=${user.user_id}`);
    await connection.execute('UPDATE users SET last_discount_code = ? WHERE user_id = ?', [generatedCode, user.user_id]);

    // 7) Return the new code and updated points balance
    console.log(`DEBUG: Successfully redeemed. Returning code=${generatedCode}, newPoints=${newPoints}`);
    return res.json({
      message: 'Redeemed points successfully.',
      discountCode: generatedCode,
      newPoints: newPoints
    });

  } catch (error) {
    console.error('Error redeeming points:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    if (connection) {
      await connection.release();
      console.log("DEBUG: Released connection back to pool");
    }
  }
});




/********************************************************************
 * Helper function to create a discount code via Shopify Admin API
 ********************************************************************/
async function createShopifyDiscountCode(amountOff) {
  const adminApiUrl = 'https://hemlock-oak.myshopify.com/admin/api/2025-01';
  const adminApiToken = process.env.SHOPIFY_ADMIN_TOKEN;

  // Parse percentage value
  const numericValue = parseFloat(amountOff.replace(/\D/g, '')) || 10;
  const discountCode = `POINTS${numericValue}PCT_${Math.random().toString(36).substr(2,5).toUpperCase()}`;

  try {
    // 1. Create Price Rule with simplified structure
    const priceRuleResponse = await fetch(`${adminApiUrl}/price_rules.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': adminApiToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        price_rule: {
          title: `${numericValue}% Points Reward`,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: "percentage",
          value: (-numericValue).toString(), // Negative percentage
          customer_selection: "all",
          starts_at: new Date().toISOString(),
          usage_limit: 1,
          once_per_customer: true
        }
      })
    });

    // Improved error handling
    if (!priceRuleResponse.ok) {
      const errorData = await priceRuleResponse.json();
      console.error('Price Rule Error Details:', JSON.stringify(errorData, null, 2));
      throw new Error(`Price rule failed: ${errorData.errors || errorData.message}`);
    }

    const priceRuleData = await priceRuleResponse.json();
    const priceRuleId = priceRuleData.price_rule.id;

        // 2. Create Discount Code under the Price Rule
    const discountResponse = await fetch(
      `${adminApiUrl}/price_rules/${priceRuleId}/discount_codes.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': adminApiToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          discount_code: {
            code: discountCode,
            usage_count: 0
          }
        })
      }
    );

    if (!discountResponse.ok) {
      const error = await discountResponse.json();
      // Clean up price rule if discount creation fails
      await fetch(`${adminApiUrl}/price_rules/${priceRuleId}.json`, {
        method: 'DELETE',
        headers: {
          'X-Shopify-Access-Token': adminApiToken
        }
      });
      throw new Error(`Discount code creation failed: ${error.errors}`);
    }

    return discountCode;

  } catch (error) {
    console.error('Discount creation error:', error);
    throw new Error('Failed to create discount code');
  }
}

// (Optional) Implement createShopifyGiftCard() similarly if you plan to support gift cards.

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Configured for shop: ${SHOP_DOMAIN}`);
});
