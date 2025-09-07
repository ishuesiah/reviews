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
  origin(origin, cb) {
    const allowed = [
      'https://www.hemlockandoak.com',
      'https://hemlock-oak.myshopify.com',
      'http://127.0.0.1:9292',
      'http://localhost:9292',
      'http://localhost:3000'
    ];
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type','Authorization']
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
    let discountId = '';
    
    if (redeemType === 'discount') {
      console.log(`DEBUG: Creating discount code for redeemValue=${redeemValue}`);
      const result = await createShopifyDiscountCode(redeemValue, pointsToRedeem);
      generatedCode = result.code;
      discountId = result.discountId;
    } else if (redeemType === 'gift_card') {
      // If you implement gift cards later
      generatedCode = await createShopifyGiftCard(redeemValue);
    } else {
      const result = await createShopifyDiscountCode(redeemValue, pointsToRedeem);
      generatedCode = result.code;
      discountId = result.discountId;
    }
    
    // 6) Save the generated discount code and ID to the database
    await connection.execute(
      'UPDATE users SET last_discount_code = ?, discount_code_id = ?, points = ? WHERE user_id = ?',
      [generatedCode, discountId, newPoints, user.user_id]
    );


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
async function createShopifyDiscountCode(amountOff, pointsToRedeem, options = {}) {
  const adminApiUrl = 'https://hemlock-oak.myshopify.com/admin/api/2025-04/graphql.json';
  const adminApiToken = process.env.SHOPIFY_ADMIN_TOKEN;

  const rewardType = options.rewardType || 'fixed_amount';
  let generatedCode = '';
  let variables = {};
  let title = '';

  if (rewardType === 'free_product') {
    generatedCode = `MILESTONEFREE_${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    title = `Free Collection Reward (${generatedCode})`;

    if (!options.collectionId) {
      throw new Error('Missing collectionId for free collection reward');
    }

    variables = {
      basicCodeDiscount: {
        title,
        code: generatedCode,
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: {
          value: { percentage: 1.0 },
          items: {
            collections: {
              add: [options.collectionId] // ✅ Correct collection format
            }
          }
        },
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: false,
          shippingDiscounts: true
        },
        usageLimit: 1,
        appliesOncePerCustomer: true
      }
    };

  } else {
    const numericValue = amountOff === 'dynamic'
      ? (pointsToRedeem / 100).toFixed(2)
      : parseFloat(amountOff.replace(/\D/g, '')) || 5;

    generatedCode = `POINTS${numericValue}CAD_${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    title = `$${numericValue} Off Points Reward`;

    variables = {
      basicCodeDiscount: {
        title,
        code: generatedCode,
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: {
          value: {
            discountAmount: {
              amount: numericValue,
              appliesOnEachItem: false
            }
          },
          items: { all: true }
        },
        combinesWith: {
          orderDiscounts: true,
          productDiscounts: true,
          shippingDiscounts: true
        },
        usageLimit: 1,
        appliesOncePerCustomer: true
      }
    };
  }

  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              codes(first: 1) {
                nodes {
                  code
                }
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await fetch(adminApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminApiToken
    },
    body: JSON.stringify({ query: mutation, variables })
  });

  const result = await response.json();

  if (result.errors || result.data?.discountCodeBasicCreate?.userErrors?.length > 0) {
    console.error('Discount creation error:', JSON.stringify(result, null, 2));
    throw new Error('Failed to create discount code');
  }

  const discountBasic = result.data.discountCodeBasicCreate.codeDiscountNode.codeDiscount;
  const discountBasicId = result.data.discountCodeBasicCreate.codeDiscountNode.id;

  return {
    code: discountBasic.codes.nodes[0].code,
    discountId: discountBasicId.replace('DiscountCodeNode', 'DiscountCodeBasic')
  };
}





/********************************************************************
Delete shopify discount
 ********************************************************************/


async function deactivateShopifyDiscount(discountId) {
  const adminApiUrl = 'https://hemlock-oak.myshopify.com/admin/api/2025-04/graphql.json';
  const adminApiToken = process.env.SHOPIFY_ADMIN_TOKEN;

  // Step 1: Query existing discount to get startsAt
const query = `
  query getDiscount($id: ID!) {
    codeDiscountNode(id: $id) {
      codeDiscount {
        ... on DiscountCodeBasic {
          startsAt
        }
      }
    }
  }
`;


  const queryResponse = await fetch(adminApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminApiToken
    },
    body: JSON.stringify({
      query,
      variables: { id: discountId }
    })
  });

  const queryResult = await queryResponse.json();
  const startsAt = queryResult.data?.codeDiscountNode?.codeDiscount?.startsAt;

  if (!startsAt) {
    throw new Error('Could not retrieve startsAt for discount');
  }

  // Step 2: Set endsAt to +1 minute after startsAt
  const endsAt = new Date(new Date(startsAt).getTime() + 60 * 1000).toISOString();

  // Step 3: Run update mutation to set endsAt
    const mutation = `
  mutation discountCodeBasicUpdate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;


  const variables = {
    id: discountId,
    basicCodeDiscount: {
      endsAt: endsAt
    }
  };

  const response = await fetch(adminApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminApiToken
    },
    body: JSON.stringify({ query: mutation, variables })
  });

  const result = await response.json();
  console.log('🧪 Deactivate mutation result:', JSON.stringify(result, null, 2));

  const userErrors = result.data?.discountCodeBasicUpdate?.userErrors || [];

  if (userErrors.length > 0) {
    throw new Error(userErrors[0].message || 'Failed to deactivate discount');
  }

  console.log('✅ Successfully deactivated discount code');
  return true;
}







/********************************************************************
 * POST /api/referral/mark-discount-used
 * Body: {
 *   "email": "user@example.com",
 *   "usedCode": "POINTS10CAD_ABC12"
 * }
 ********************************************************************/
app.post('/api/referral/mark-discount-used', async (req, res) => {
  let connection;
  try {
    const { email, usedCode } = req.body;

    if (!email || !usedCode) {
      return res.status(400).json({ error: 'Missing email or usedCode.' });
    }

    connection = await pool.getConnection();
    console.log(`DEBUG: Looking up user ${email} for code ${usedCode}`);

    const [rows] = await connection.execute(
      'SELECT * FROM users WHERE email = ? AND last_discount_code = ?',
      [email, usedCode]
    );

    if (rows.length === 0) {
      console.log('DEBUG: No matching user/code found');
      return res.status(404).json({ error: 'User with that code not found or code does not match.' });
    }

    const user = rows[0];

    // ✅ Step 1: Clear both discount fields from DB first
    await connection.execute(
      'UPDATE users SET last_discount_code = NULL, discount_code_id = NULL WHERE email = ?',
      [email]
    );
    console.log(`✅ Cleared last_discount_code and discount_code_id for ${email}`);

    // ✅ Step 2: Then deactivate the discount in Shopify (if ID existed)
    if (user.discount_code_id) {
      try {
        await deactivateShopifyDiscount(user.discount_code_id);
        console.log(`✅ Deactivated discount in Shopify: ${user.discount_code_id}`);
      } catch (err) {
        console.error('⚠️ Failed to deactivate Shopify discount:', err.message);
      }
    }

    res.json({ message: 'Discount removed from DB and deactivated in Shopify (if needed).' });

  } catch (err) {
    console.error('❌ Error in mark-discount-used:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});



app.post('/api/referral/cancel-redeem', async (req, res) => {
  const { email, pointsToRefund } = req.body;

  if (!email || !pointsToRefund) {
    return res.status(400).json({ error: 'Missing email or points to refund.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [userRows] = await connection.execute(
      'SELECT * FROM users WHERE email = ?', [email]
    );

    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = userRows[0];
    const newPoints = user.points + parseInt(pointsToRefund, 10);

    // Attempt to delete the discount from Shopify if an ID exists
    if (user.discount_code_id) {
      try {
        await deactivateShopifyDiscount(user.discount_code_id);

        console.log(`Deleted discount from Shopify: ${user.discount_code_id}`);
      } catch (err) {
        console.error('Failed to delete discount from Shopify:', err.message);
      }
    }

    // Refund points and clear both code fields
    await connection.execute(
      'UPDATE users SET points = ?, last_discount_code = NULL, discount_code_id = NULL WHERE email = ?',
      [newPoints, email]
    );

    return res.json({ message: 'Points refunded.', newPoints });

  } catch (err) {
    console.error('Cancel redeem error:', err);
    return res.status(500).json({ error: 'Failed to refund points.' });
  } finally {
    if (connection) connection.release();
  }
});


//REDEEM MILESTONE PROGRESS REWARD
app.post('/api/referral/redeem-milestone', async (req, res) => {
  const { email, milestonePoints } = req.body;

  // ✅ Collection-based milestone rewards
  const milestoneRewards = {
    5: { name: 'Free Notebook', collectionId: 'gid://shopify/Collection/410265616628' },
    10: { name: 'Free Planner', collectionId: 'gid://shopify/Collection/423756136692' },
    15: { name: 'Free Planner', collectionId: 'gid://shopify/Collection/423756136692' }
  };

  if (!email || !milestonePoints || !milestoneRewards[milestonePoints]) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = rows[0];
    const reward = milestoneRewards[milestonePoints];

    // Ensure user has enough referrals
    if ((user.referral_count || 0) < milestonePoints) {
      return res.status(400).json({ error: `You need ${milestonePoints} referrals to unlock this reward.` });
    }

    // Parse previously redeemed milestones
    let redeemedMilestones = {};
    if (user.referal_discount_code) {
      try {
        redeemedMilestones = JSON.parse(user.referal_discount_code);
      } catch (err) {
        console.warn('Could not parse referal_discount_code:', err.message);
      }
    }

    if (redeemedMilestones[milestonePoints]) {
      return res.status(400).json({ error: 'Milestone already redeemed.' });
    }

    // ✅ Create a 100% off discount for collection
    const { code: discountCode, discountId } = await createShopifyDiscountCode('100', 0, {
      rewardType: 'free_product',
      collectionId: reward.collectionId
    });

    redeemedMilestones[milestonePoints] = discountCode;

    await connection.execute(
      'UPDATE users SET referal_discount_code = ? WHERE user_id = ?',
      [JSON.stringify(redeemedMilestones), user.user_id]
    );

    return res.json({
      message: 'Milestone redeemed!',
      rewardName: reward.name,
      discountCode
    });

  } catch (err) {
    console.error('Milestone redemption error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});





// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Configured for shop: ${SHOP_DOMAIN}`);
});
