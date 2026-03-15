/**
 * GoatX402 Pay Demo Application
 */

import { useState, useCallback, useMemo } from 'react'
import { useWallet } from './hooks/useWallet'
import { useGoatX402 } from './hooks/useGoatX402'
import { useConfig } from './hooks/useConfig'
import { ConnectWallet } from './components/ConnectWallet'
import { PaymentStatus } from './components/PaymentStatus'
import type { MerchantConfig } from './hooks/useConfig'

type Step = 'resume' | 'mcq' | 'status'

interface SessionSummary {
  id: string
  resumePaid: boolean
  statusPaid: boolean
  passed: boolean | null
  mcqScore: number | null
}

const GOAT_CHAIN_ID = 48816

function App() {
  const wallet = useWallet()
  const goatx402 = useGoatX402(wallet.signer)
  const { merchantConfig, loading: configLoading, error: configError } = useConfig()

  const [currentStep, setCurrentStep] = useState<Step>('resume')
  const [session, setSession] = useState<SessionSummary | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [mcqSubmitting, setMcqSubmitting] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [appError, setAppError] = useState<string | null>(null)

  const goatChainToken = useMemo(() => {
    if (!merchantConfig) return null
    const chain = merchantConfig.chains.find((c) => c.chainId === GOAT_CHAIN_ID)
    if (!chain || chain.tokens.length === 0) return null
    return chain.tokens[0]
  }, [merchantConfig])

  const ensureWalletOnGoat = useCallback(async () => {
    if (!wallet.isConnected) {
      throw new Error('Connect your wallet first')
    }
    if (wallet.chainId !== GOAT_CHAIN_ID) {
      await wallet.switchChain(GOAT_CHAIN_ID)
    }
  }, [wallet])

  const startResumeFlow = useCallback(
    async (file: File, name: string, email: string) => {
      try {
        setAppError(null)
        setAnalysisLoading(true)
        await ensureWalletOnGoat()

        if (!goatChainToken || !wallet.address) {
          throw new Error('Goat Testnet token or wallet not available')
        }

        const formData = new FormData()
        formData.append('file', file)
        formData.append('name', name)
        formData.append('email', email)
        formData.append('walletAddress', wallet.address)

        const res = await fetch('/api/resume/start', {
          method: 'POST',
          body: formData,
        })

        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${res.status}`)
        }

        const { sessionId, order } = (await res.json()) as {
          sessionId: string
          order: {
            chainId: number
            tokenContract: string
            tokenSymbol: string
            amount: string
            callbackCalldata?: string
          }
        }

        await goatx402.pay({
          chainId: order.chainId,
          tokenContract: order.tokenContract,
          tokenSymbol: order.tokenSymbol,
          amount: order.amount,
          callbackCalldata: order.callbackCalldata,
        })

        if (!goatx402.orderStatus || goatx402.orderStatus.status !== 'PAYMENT_CONFIRMED') {
          throw new Error('Payment not confirmed yet. Please wait or try again.')
        }

        const confirmRes = await fetch('/api/resume/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            orderId: goatx402.orderStatus.orderId,
          }),
        })

        if (!confirmRes.ok) {
          const data = await confirmRes.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${confirmRes.status}`)
        }

        const sessionData = (await confirmRes.json()) as SessionSummary
        setSession(sessionData)
        setCurrentStep('mcq')
      } catch (err) {
        setAppError(err instanceof Error ? err.message : 'Failed to start resume analysis')
      } finally {
        setAnalysisLoading(false)
      }
    },
    [ensureWalletOnGoat, goatChainToken, wallet.address, goatx402]
  )

  const submitMcqAnswers = useCallback(
    async (answers: Record<string, string>) => {
      if (!session) return
      try {
        setAppError(null)
        setMcqSubmitting(true)
        const res = await fetch('/api/interview/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: session.id, answers }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        const updated = (await res.json()) as SessionSummary
        setSession(updated)
        setCurrentStep('status')
      } catch (err) {
        setAppError(err instanceof Error ? err.message : 'Failed to submit answers')
      } finally {
        setMcqSubmitting(false)
      }
    },
    [session]
  )

  const payForStatus = useCallback(async () => {
    if (!session) return
    try {
      setAppError(null)
      setStatusLoading(true)
      await ensureWalletOnGoat()

      if (!goatChainToken) {
        throw new Error('Goat Testnet token not available')
      }

      const res = await fetch('/api/status/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const { order } = (await res.json()) as {
        order: {
          chainId: number
          tokenContract: string
          tokenSymbol: string
          amount: string
          callbackCalldata?: string
        }
      }

      await goatx402.pay({
        chainId: order.chainId,
        tokenContract: order.tokenContract,
        tokenSymbol: order.tokenSymbol,
        amount: order.amount,
        callbackCalldata: order.callbackCalldata,
      })

      if (!goatx402.orderStatus || goatx402.orderStatus.status !== 'PAYMENT_CONFIRMED') {
        throw new Error('Payment not confirmed yet. Please wait or try again.')
      }

      const statusRes = await fetch(`/api/status/${session.id}`)
      if (!statusRes.ok) {
        const data = await statusRes.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${statusRes.status}`)
      }
      const updated = (await statusRes.json()) as SessionSummary
      setSession(updated)
    } catch (err) {
      setAppError(err instanceof Error ? err.message : 'Failed to view status')
    } finally {
      setStatusLoading(false)
    }
  }, [session, ensureWalletOnGoat, goatChainToken, goatx402])

  const resetFlow = useCallback(() => {
    setSession(null)
    setCurrentStep('resume')
    setAppError(null)
    goatx402.reset()
  }, [goatx402])

  return (
    <div className="min-h-screen bg-gray-100 py-8">
      <div className="max-w-2xl mx-auto px-4 space-y-4">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-800">Agent Interview dApp</h1>
          <p className="text-gray-600 mt-2">
            Upload resume → pay for AI analysis → answer MCQs → pay to reveal interview result.
          </p>
          {merchantConfig && (
            <p className="text-sm text-gray-500 mt-1">
              Merchant: {merchantConfig.merchantName} · Chain: GOAT Testnet ({GOAT_CHAIN_ID})
            </p>
          )}
        </div>

        {configError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-600 text-sm">Failed to load config: {configError}</p>
          </div>
        )}

        {configLoading && (
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <p className="text-gray-500">Loading merchant configuration...</p>
          </div>
        )}

        <ConnectWallet
          isConnected={wallet.isConnected}
          address={wallet.address}
          chainId={wallet.chainId}
          loading={wallet.loading}
          error={wallet.error}
          onConnect={wallet.connect}
          onDisconnect={wallet.disconnect}
        />

        {appError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {appError}
          </div>
        )}

        {!configLoading && !configError && (
          <div className="bg-white rounded-lg shadow p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <span
                  className={`px-2 py-1 rounded-full ${
                    currentStep === 'resume' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  1. Resume
                </span>
                <span className="w-8 h-px bg-gray-300" />
                <span
                  className={`px-2 py-1 rounded-full ${
                    currentStep === 'mcq' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  2. MCQ
                </span>
                <span className="w-8 h-px bg-gray-300" />
                <span
                  className={`px-2 py-1 rounded-full ${
                    currentStep === 'status' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  3. Status
                </span>
              </div>
              {session && (
                <button
                  onClick={resetFlow}
                  className="text-xs text-blue-600 hover:text-blue-800 underline"
                >
                  Start new candidate
                </button>
              )}
            </div>

            {currentStep === 'resume' && (
              <ResumeStep
                loading={analysisLoading || goatx402.loading}
                onStart={startResumeFlow}
                tokenSymbol={goatChainToken?.symbol}
              />
            )}

            {currentStep === 'mcq' && session && (
              <McqStep loading={mcqSubmitting} onSubmit={submitMcqAnswers} />
            )}

            {currentStep === 'status' && session && (
              <StatusStep
                session={session}
                loading={statusLoading || goatx402.loading}
                onPay={payForStatus}
              />
            )}
          </div>
        )}

        <PaymentStatus
          order={goatx402.order}
          result={goatx402.paymentResult}
          status={goatx402.orderStatus}
          error={goatx402.error}
          onReset={goatx402.reset}
        />

        <div className="text-center text-sm text-gray-500 mt-4">
          <p>Powered by GoatX402 SDK · ERC-8004 Agent Identity ready</p>
          <p className="mt-1">{wallet.chainId ? `Current chain: ${wallet.chainId}` : 'Not connected'}</p>
        </div>
      </div>
    </div>
  )
}

interface ResumeStepProps {
  loading: boolean
  onStart: (file: File, name: string, email: string) => void
  tokenSymbol?: string
}

function ResumeStep({ loading, onStart, tokenSymbol }: ResumeStepProps) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!file || !name || !email) return
    onStart(file, name, email)
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-800 mb-2">Step 1 · Resume Analysis</h2>
      <p className="text-sm text-gray-600 mb-4">
        Upload your resume and pay once to have the OpenClaw agent analyze your profile on GOAT
        Testnet.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
          <input
            type="text"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
          <input
            type="email"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Resume (PDF or DOCX)</label>
          <input
            type="file"
            accept=".pdf,.doc,.docx"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="w-full text-sm"
            required
          />
        </div>
        <button
          type="submit"
          disabled={loading || !file || !name || !email}
          className="w-full py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Processing payment & analysis...' : `Pay & Analyze Resume${tokenSymbol ? ` (${tokenSymbol})` : ''}`}
        </button>
      </form>
    </div>
  )
}

interface McqStepProps {
  loading: boolean
  onSubmit: (answers: Record<string, string>) => void
}

function McqStep({ loading, onSubmit }: McqStepProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const questions = [
    {
      id: 'q1',
      text: 'How comfortable are you with TypeScript in production systems?',
      options: ['Beginner', 'Intermediate', 'Advanced'],
    },
    {
      id: 'q2',
      text: 'Pick the best description of your blockchain experience:',
      options: ['Just learning', 'Built small dApps', 'Shipped production protocols'],
    },
    {
      id: 'q3',
      text: 'How do you prefer to work with AI agents?',
      options: ['As coding assistants', 'As autonomous services', 'Both equally'],
    },
  ]

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (questions.some((q) => !answers[q.id])) return
    onSubmit(answers)
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-800 mb-2">Step 2 · MCQ Interview</h2>
      <p className="text-sm text-gray-600 mb-4">
        Answer a few multiple choice questions so the Interview Agent can score your profile.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        {questions.map((q) => (
          <div key={q.id}>
            <p className="text-sm font-medium text-gray-800 mb-1">{q.text}</p>
            <div className="space-y-1">
              {q.options.map((opt) => (
                <label key={opt} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="radio"
                    name={q.id}
                    value={opt}
                    checked={answers[q.id] === opt}
                    onChange={() =>
                      setAnswers((prev) => ({
                        ...prev,
                        [q.id]: opt,
                      }))
                    }
                  />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
        <button
          type="submit"
          disabled={loading || questions.some((q) => !answers[q.id])}
          className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Submitting answers...' : 'Submit Answers'}
        </button>
      </form>
    </div>
  )
}

interface StatusStepProps {
  session: SessionSummary
  loading: boolean
  onPay: () => void
}

function StatusStep({ session, loading, onPay }: StatusStepProps) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-800 mb-2">Step 3 · Final Status</h2>
      <p className="text-sm text-gray-600 mb-4">
        The Decision Agent has combined your resume analysis and MCQ answers. Pay once to reveal the
        final interview result on-chain.
      </p>

      <div className="mb-4 text-sm text-gray-700">
        <p>
          Resume analysis paid:{' '}
          <span className={session.resumePaid ? 'text-green-600' : 'text-red-600'}>
            {session.resumePaid ? 'Yes' : 'No'}
          </span>
        </p>
        <p>
          Status unlocked:{' '}
          <span className={session.statusPaid ? 'text-green-600' : 'text-yellow-600'}>
            {session.statusPaid ? 'Yes' : 'No'}
          </span>
        </p>
      </div>

      {!session.statusPaid && (
        <button
          type="button"
          onClick={onPay}
          disabled={loading}
          className="w-full py-2.5 bg-purple-600 text-white rounded-lg text-sm font-semibold hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed mb-4"
        >
          {loading ? 'Processing payment...' : 'Pay to View Result'}
        </button>
      )}

      {session.statusPaid && (
        <div className="mt-2 p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-1 text-sm">
          <p>
            Result:{' '}
            <span
              className={
                session.passed === null
                  ? 'text-gray-700'
                  : session.passed
                    ? 'text-green-700 font-semibold'
                    : 'text-red-700 font-semibold'
              }
            >
              {session.passed === null ? 'Pending decision' : session.passed ? 'Passed' : 'Not passed'}
            </span>
          </p>
          {session.mcqScore !== null && <p>MCQ score: {session.mcqScore}</p>}
        </div>
      )}
    </div>
  )
}

export default App
