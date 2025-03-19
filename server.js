// server.js - Node.js proxy for Judge.me reviews
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for your Shopify store domain
app.use(cors({
  origin: process.env.SHOPIFY_STORE_URL || 'https://hemlock-oak.myshopify.com',
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// Get Judge.me configuration from environment variables
const JUDGEME_API_TOKEN = process.env.JUDGEME_API_TOKEN;
const SHOP_DOMAIN = process.env.SHOP_DOMAIN || 'hemlock-oak.myshopify.com';
const PLATFORM = process.env.PLATFORM || 'shopify';

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


//Check if running
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
    // Get the customer email from the query parameter
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Customer email is required' });
    }
    
    console.log(`Fetching reviews for customer: ${email}`);
    
    // Call Judge.me API to get reviews by this customer
    const reviewsResponse = await axios.get('https://judge.me/api/v1/reviews', {
      params: {
        api_token: JUDGEME_API_TOKEN,
        shop_domain: SHOP_DOMAIN,
        platform: PLATFORM,
        reviewer_email: email
      }
    });
    
    // Return the reviews data
    return res.json(reviewsResponse.data);
  } catch (error) {
    console.error('Error fetching reviews:', error.message);
    
    // More detailed error logging
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
 *   "redeemValue": "10OFF" // could be $ amount, % off, free shipping, etc.
 * }
 ********************************************************************/
app.post('/api/referral/redeem', async (req, res) => {
  try {
    const { email, pointsToRedeem, redeemType, redeemValue } = req.body;
    if (!email || !pointsToRedeem) {
      return res.status(400).json({ error: 'Missing email or pointsToRedeem.' });
    }
    
    // 1) Find user
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = rows[0];
    
    // 2) Check points
    if (user.points < pointsToRedeem) {
      return res.status(400).json({ error: 'Not enough points to redeem.' });
    }
    
    // 3) Subtract from MySQL
    const newPoints = user.points - pointsToRedeem;
    await pool.execute('UPDATE users SET points = ? WHERE user_id = ?', [newPoints, user.user_id]);
    
    // 4) Call Shopify Admin to create code
    let generatedCode = '';
    
    if (redeemType === 'discount') {
      generatedCode = await createShopifyDiscountCode(redeemValue); // see function below
    } else if (redeemType === 'gift_card') {
      generatedCode = await createShopifyGiftCard(redeemValue); // implement similarly
    } else {
      // default to discount if not specified
      generatedCode = await createShopifyDiscountCode(redeemValue);
    }
    
    // 5) Log the redemption
    const insertActionSql = `
      INSERT INTO user_actions (user_id, action_type, points_awarded)
      VALUES (?, ?, ?)
    `;
    await pool.execute(insertActionSql, [user.user_id, `redeem-${redeemType}`, -pointsToRedeem]);
    
    // 6) Return the new code
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
 * This example creates a “Basic” discount code for a fixed amount off.
 * Adjust the mutation for free shipping or percentage discounts as needed.
 ********************************************************************/
async function createShopifyDiscountCode(amountOff) {
  // Use your real Admin API credentials
  const adminApiUrl = 'https://hemlock-oak.myshopify.com/api/2023-07/graphql.json';
  const adminApiToken = process.env.SHOPIFY_ADMIN_TOKEN; // keep in .env
  
  // Example mutation for a fixed-amount discount code
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
  
  // For uniqueness, you might combine the `amountOff` with random characters:
  const uniqueSuffix = Math.random().toString(36).substr(2, 5).toUpperCase();
  const codeTitle = `POINTS-${amountOff}-${uniqueSuffix}`;
  
  // Basic fixed-amount discount example: $X off entire order
  const variables = {
    basicCodeDiscount: {
      title: codeTitle,
      startsAt: new Date().toISOString(), // set to “now”
      usageLimit: 1, // optional, how many times code can be used
      appliesOncePerCustomer: true,
      customerSelection: { all: true },
      code: codeTitle,
      discountAmount: {
        amount: parseFloat(amountOff.replace(/\D/g,'')), // extract numeric from '10OFF'
        // if you want a percentage discount, define "percentage" instead
        // e.g.: discountType: PERCENTAGE
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
  
  // Extract final code from returned data
  const codeNode = responseData.data.discountCodeBasicCreate.codeDiscountNode.codeDiscount.codes.edges[0].node;
  return codeNode.code;
}


// Start the server
app.listen(port, () => {
  console.log(`Judge.me proxy server running on port ${port}`);
  console.log(`Configured for shop: ${SHOP_DOMAIN}`);
});
