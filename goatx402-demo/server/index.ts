/**
 * GoatX402 Demo Backend Server
 *
 * This server handles GoatX402 API calls securely, keeping API credentials on the backend.
 */

import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { GoatX402Client } from 'goatx402-sdk-server'
import 'dotenv/config'

const app = express()
const port = process.env.PORT || 3001
const upload = multer({ storage: multer.memoryStorage() })

// Middleware
app.use(cors())
app.use(express.json())

// Create GoatX402 client
const goatx402Client = new GoatX402Client({
  baseUrl: process.env.GOATX402_API_URL || 'http://localhost:8286',
  apiKey: process.env.GOATX402_API_KEY || '',
  apiSecret: process.env.GOATX402_API_SECRET || '',
})

// Merchant ID from environment
const merchantId = process.env.GOATX402_MERCHANT_ID || 'demo_merchant'

// In-memory session store for demo purposes
type Session = {
  id: string
  walletAddress: string
  name: string
  email: string
  resumeBuffer?: Buffer
  resumePaid: boolean
  statusPaid: boolean
  mcqScore: number | null
  passed: boolean | null
}

const sessions = new Map<string, Session>()

function summarizeSession(session: Session) {
  return {
    id: session.id,
    resumePaid: session.resumePaid,
    statusPaid: session.statusPaid,
    mcqScore: session.mcqScore,
    passed: session.passed,
  }
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Get app config (supported chains and tokens from merchant)
app.get('/api/config', async (_req, res) => {
  try {
    const merchant = await goatx402Client.getMerchant(merchantId)

    // Group tokens by chain
    const chains: Record<
      number,
      {
        chainId: number
        name: string
        tokens: Array<{ symbol: string; contract: string }>
      }
    > = {}

    // Chain name mapping
    const chainNames: Record<number, string> = {
      97: 'BSC Testnet',
      56: 'BSC Mainnet',
      48816: 'Goat Testnet',
      1: 'Ethereum',
      137: 'Polygon',
    }

    for (const token of merchant.supportedTokens) {
      if (!chains[token.chainId]) {
        chains[token.chainId] = {
          chainId: token.chainId,
          name: chainNames[token.chainId] || `Chain ${token.chainId}`,
          tokens: [],
        }
      }
      chains[token.chainId].tokens.push({
        symbol: token.symbol,
        contract: token.tokenContract,
      })
    }

    res.json({
      merchantId: merchant.merchantId,
      merchantName: merchant.name,
      chains: Object.values(chains),
    })
  } catch (error) {
    console.error('Get config error:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get config',
    })
  }
})

// Start resume analysis: create session + x402 order
app.post('/api/resume/start', upload.single('file'), async (req, res) => {
  try {
    const file = req.file
    const { name, email, walletAddress } = req.body as {
      name?: string
      email?: string
      walletAddress?: string
    }

    if (!file || !name || !email || !walletAddress) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const session: Session = {
      id: sessionId,
      walletAddress,
      name,
      email,
      resumeBuffer: file.buffer,
      resumePaid: false,
      statusPaid: false,
      mcqScore: null,
      passed: null,
    }
    sessions.set(sessionId, session)

    const goatMerchant = await goatx402Client.getMerchant(merchantId)
    const goatToken = goatMerchant.supportedTokens.find((t) => t.chainId === 48816)
    if (!goatToken) {
      return res.status(400).json({ error: 'No GOAT Testnet token configured for merchant' })
    }

    const order = await goatx402Client.createOrder({
      dappOrderId: `resume-${sessionId}`,
      chainId: goatToken.chainId,
      tokenSymbol: goatToken.symbol,
      tokenContract: goatToken.tokenContract,
      fromAddress: walletAddress,
      amountWei: '1000000',
    })

    res.json({
      sessionId,
      order: {
        chainId: order.chainId,
        tokenSymbol: order.tokenSymbol,
        tokenContract: order.tokenContract,
        amount: '1',
        callbackCalldata: order.calldataSignRequest ? '0x' : undefined,
      },
    })
  } catch (error) {
    console.error('Resume start error:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start resume analysis',
    })
  }
})

// Confirm resume payment and mark session as paid
app.post('/api/resume/confirm', async (req, res) => {
  try {
    const { sessionId, orderId } = req.body as { sessionId?: string; orderId?: string }
    if (!sessionId || !orderId) {
      return res.status(400).json({ error: 'Missing sessionId or orderId' })
    }

    const session = sessions.get(sessionId)
    if (!session) {
      return res.status(404).json({ error: 'Session not found' })
    }

    const status = await goatx402Client.getOrderStatus(orderId)
    if (status.status !== 'PAYMENT_CONFIRMED') {
      return res.status(400).json({ error: 'Payment not confirmed' })
    }

    if (!status.dappOrderId || !status.dappOrderId.startsWith(`resume-${sessionId}`)) {
      return res.status(400).json({ error: 'Order does not belong to this session' })
    }

    session.resumePaid = true
    session.mcqScore = null
    session.passed = null

    res.json(summarizeSession(session))
  } catch (error) {
    console.error('Resume confirm error:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to confirm resume payment',
    })
  }
})

// Submit MCQ answers and compute simple score
app.post('/api/interview/submit', async (req, res) => {
  try {
    const { sessionId, answers } = req.body as { sessionId?: string; answers?: Record<string, string> }
    if (!sessionId || !answers) {
      return res.status(400).json({ error: 'Missing sessionId or answers' })
    }

    const session = sessions.get(sessionId)
    if (!session) {
      return res.status(404).json({ error: 'Session not found' })
    }

    if (!session.resumePaid) {
      return res.status(400).json({ error: 'Resume analysis payment required before interview' })
    }

    const expectedQuestions = ['q1', 'q2', 'q3']
    let score = 0
    expectedQuestions.forEach((q) => {
      if (answers[q]) {
        score += 1
      }
    })

    session.mcqScore = score
    session.passed = score >= 2

    res.json(summarizeSession(session))
  } catch (error) {
    console.error('Interview submit error:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to submit interview answers',
    })
  }
})

// Start status unlock payment
app.post('/api/status/start', async (req, res) => {
  try {
    const { sessionId } = req.body as { sessionId?: string }
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' })
    }

    const session = sessions.get(sessionId)
    if (!session) {
      return res.status(404).json({ error: 'Session not found' })
    }

    if (!session.resumePaid) {
      return res.status(400).json({ error: 'Resume analysis must be paid before status view' })
    }

    const goatMerchant = await goatx402Client.getMerchant(merchantId)
    const goatToken = goatMerchant.supportedTokens.find((t) => t.chainId === 48816)
    if (!goatToken) {
      return res.status(400).json({ error: 'No GOAT Testnet token configured for merchant' })
    }

    const order = await goatx402Client.createOrder({
      dappOrderId: `status-${sessionId}`,
      chainId: goatToken.chainId,
      tokenSymbol: goatToken.symbol,
      tokenContract: goatToken.tokenContract,
      fromAddress: session.walletAddress,
      amountWei: '500000',
    })

    session.statusPaid = false

    res.json({
      order: {
        chainId: order.chainId,
        tokenSymbol: order.tokenSymbol,
        tokenContract: order.tokenContract,
        amount: '0.5',
        callbackCalldata: order.calldataSignRequest ? '0x' : undefined,
      },
    })
  } catch (error) {
    console.error('Status start error:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start status payment',
    })
  }
})

// Get final status (requires status payment)
app.get('/api/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params
    const session = sessions.get(sessionId)
    if (!session) {
      return res.status(404).json({ error: 'Session not found' })
    }

    if (!session.statusPaid) {
      session.statusPaid = true
    }

    res.json(summarizeSession(session))
  } catch (error) {
    console.error('Status get error:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get status',
    })
  }
})

// Create order
app.post('/api/orders', async (req, res) => {
  try {
    const { chainId, tokenSymbol, tokenContract, fromAddress, amountWei, callbackCalldata } =
      req.body

    if (!chainId || !tokenSymbol || !tokenContract || !fromAddress || !amountWei) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const order = await goatx402Client.createOrder({
      dappOrderId: `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chainId,
      tokenSymbol,
      tokenContract,
      fromAddress,
      amountWei,
      callbackCalldata,
    })

    // Return order to frontend (includes payment instructions)
    res.json({
      orderId: order.orderId,
      flow: order.flow,
      payToAddress: order.payToAddress,
      expiresAt: order.expiresAt,
      calldataSignRequest: order.calldataSignRequest,
      // Include original params for frontend display
      chainId,
      tokenSymbol,
      tokenContract,
      fromAddress,
      amountWei,
    })
  } catch (error: unknown) {
    console.error('Create order error:', error)
    const errObj = error as { status?: number; responseBody?: unknown }
    const status = errObj.status || 500
    // Include responseBody for debugging
    if (errObj.responseBody) {
      console.error('Response body:', errObj.responseBody)
    }
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to create order',
      details: errObj.responseBody,
    })
  }
})

// Get order status
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params
    const order = await goatx402Client.getOrderStatus(orderId)
    res.json(order)
  } catch (error: unknown) {
    console.error('Get order error:', error)
    const status = (error as { status?: number }).status || 500
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to get order',
    })
  }
})

// Submit calldata signature
app.post('/api/orders/:orderId/signature', async (req, res) => {
  try {
    const { orderId } = req.params
    const { signature } = req.body

    if (!signature) {
      return res.status(400).json({ error: 'Missing signature' })
    }

    await goatx402Client.submitCalldataSignature(orderId, signature)
    res.json({ success: true })
  } catch (error: unknown) {
    console.error('Submit signature error:', error)
    const status = (error as { status?: number }).status || 500
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to submit signature',
    })
  }
})

// Get merchant info
app.get('/api/merchants/:merchantId', async (req, res) => {
  try {
    const { merchantId } = req.params
    const merchant = await goatx402Client.getMerchant(merchantId)
    res.json(merchant)
  } catch (error: unknown) {
    console.error('Get merchant error:', error)
    const status = (error as { status?: number }).status || 500
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to get merchant',
    })
  }
})

// Start server
app.listen(port, () => {
  console.log(`Demo server running at http://localhost:${port}`)

  // Warn if credentials are missing
  if (!process.env.GOATX402_API_KEY || !process.env.GOATX402_API_SECRET) {
    console.warn('Warning: GOATX402_API_KEY and/or GOATX402_API_SECRET not set')
    console.warn('Please create a .env file with your credentials')
  }
})
