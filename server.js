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

// Start the server
app.listen(port, () => {
  console.log(`Judge.me proxy server running on port ${port}`);
  console.log(`Configured for shop: ${SHOP_DOMAIN}`);
});
