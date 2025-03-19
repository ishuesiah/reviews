// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mysql = require('mysql2/promise'); // For MySQL pool
const fetch = require('node-fetch'); // Install with: npm install node-fetch
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN || 'hemlock-oak.myshopify.com';


// Initialize MySQL pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,         // e.g. 'localhost'
  user: process.env.MYSQL_USER,         // your MySQL username
  password: process.env.MYSQL_PASSWORD, // your MySQL password
  database: process.env.MYSQL_DATABASE, // your database name
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
app.post('/api/referral/redeem', async (req, res) => {
  try {
    const { email, pointsToRedeem, redeemType, redeemValue } = req.body;
    if (!email || !pointsToRedeem) {
      return res.status(400).json({ error: 'Missing email or pointsToRedeem.' });
    }
    
    // 1) Find user in MySQL
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = rows[0];
    
    // 2) Check if the user has enough points
    if (user.points < pointsToRedeem) {
      return res.status(400).json({ error: 'Not enough points to redeem.' });
    }
    
    // 3) Subtract redeemed points from MySQL
    const newPoints = user.points - pointsToRedeem;
    await pool.execute('UPDATE users SET points = ? WHERE user_id = ?', [newPoints, user.user_id]);
    
    // 4) Create a discount (or gift card) code via Shopify Admin API
    let generatedCode = '';
    if (redeemType === 'discount') {
      generatedCode = await createShopifyDiscountCode(redeemValue);
    } else if (redeemType === 'gift_card') {
      generatedCode = await createShopifyGiftCard(redeemValue); // You'd need to implement this similarly
    } else {
      generatedCode = await createShopifyDiscountCode(redeemValue);
    }
    
    // 5) Log the redemption in your database
    const insertActionSql = `
      INSERT INTO user_actions (user_id, action_type, points_awarded)
      VALUES (?, ?, ?)
    `;
    await pool.execute(insertActionSql, [user.user_id, `redeem-${redeemType}`, -pointsToRedeem]);
    
    // 6) Return the new code and updated points balance
    return res.json({
      message: 'Redeemed points successfully.',
      discountCode: generatedCode,
      newPoints: newPoints
    });
    
  } catch (error) {
    console.error('Error redeeming points:', error);
    return res.status(500).json({ error: error.message });
  }
});

/********************************************************************
 * Helper function to create a discount code via Shopify Admin API
 ********************************************************************/
async function createShopifyDiscountCode(amountOff) {
  // Ensure your store name is correct and your admin token is set in .env
  const adminApiUrl = 'https://hemlock-oak.myshopify.com/admin/api/2023-07/graphql.json';
  const adminApiToken = process.env.SHOPIFY_ADMIN_TOKEN;
  
  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          codeDiscount {
            __typename
            ... on DiscountCodeBasic {
              title
              codes(first: 1) {
                edges {
                  node {
                    code
                  }
                }
              }
            }
          }
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  
  // Generate a unique code title
  const uniqueSuffix = Math.random().toString(36).substr(2, 5).toUpperCase();
  const codeTitle = `POINTS-${amountOff}-${uniqueSuffix}`;
  
  const variables = {
    basicCodeDiscount: {
      title: codeTitle,
      startsAt: new Date().toISOString(),
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerSelection: { all: true },
      code: codeTitle,
      discountAmount: {
        amount: parseFloat(amountOff.replace(/\D/g, ''))
      },
      discountType: "FIXED_AMOUNT",
      appliesTo: {
        allProducts: true
      }
    }
  };
  
  const response = await fetch(adminApiUrl, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': adminApiToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: mutation, variables })
  });
  
  const responseData = await response.json();
  
  if (responseData.errors) {
    console.error('GraphQL errors:', responseData.errors);
    throw new Error('Failed to create discount code');
  }
  
  const userErrors = responseData.data.discountCodeBasicCreate.userErrors;
  if (userErrors && userErrors.length) {
    throw new Error(userErrors[0].message);
  }
  
  const codeNode = responseData.data.discountCodeBasicCreate.codeDiscountNode.codeDiscount.codes.edges[0].node;
  return codeNode.code;
}

// (Optional) Implement createShopifyGiftCard() similarly if you plan to support gift cards.

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Configured for shop: ${SHOP_DOMAIN}`);
});
