import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, RefreshCcw, Clock, Globe, ArrowRight, Terminal } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Separator } from '../components/ui/separator'
import { ThemeToggle } from '../components/ThemeToggle'
import { api } from '../api/client'

const FEATURES = [
  {
    icon: Zap,
    title: 'Real-time delivery',
    description: 'Requests appear instantly via WebSocket — no polling, no refresh.',
  },
  {
    icon: Globe,
    title: 'Any HTTP method',
    description: 'GET, POST, PUT, PATCH, DELETE — every method, every content type.',
  },
  {
    icon: RefreshCcw,
    title: 'Request replay',
    description: 'Forward any captured request to a target URL with one click.',
  },
  {
    icon: Clock,
    title: '48-hour TTL',
    description: 'Requests are automatically cleaned up after 48 hours.',
  },
]

const STEPS = [
  { n: '01', title: 'Create an endpoint', body: 'Click the button below. You get a unique inspect URL instantly — no signup.' },
  { n: '02', title: 'Send requests to it', body: 'Point any webhook, curl command, or HTTP client at your inspect URL.' },
  { n: '03', title: 'Inspect in real time', body: 'See headers, body, query params, and source IP as they arrive live.' },
]

const STORAGE_KEY = 'wi-last-endpoint'

export function HomePage() {
  const [loading, setLoading] = useState(false)
  const [existingId, setExistingId] = useState<string | null>(null)
  const navigate = useNavigate()

  // Silently validate any previously saved endpoint in the background
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      api.getEndpoint(saved)
        .then(() => setExistingId(saved))
        .catch(() => localStorage.removeItem(STORAGE_KEY))
    }
  }, [])

  // If a valid endpoint exists → take them there. Otherwise create a fresh one.
  const handleCreate = async () => {
    setLoading(true)
    try {
      if (existingId) {
        navigate(`/e/${existingId}`)
        return
      }
      const ep = await api.createEndpoint()
      navigate(`/e/${ep.id}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ── Navbar ── */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-foreground" />
            <span className="text-sm font-semibold tracking-tight">webhook inspector</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-4 py-24 gap-8">
        <div className="space-y-4 max-w-2xl">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-foreground animate-pulse" />
            Self-hostable · Open source · No signup
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground leading-tight">
            Inspect webhooks<br />in real time
          </h1>
          <p className="text-base text-muted-foreground max-w-lg mx-auto leading-relaxed">
            Get a unique URL. Send any HTTP request to it. See every header,
            body, and query parameter arrive instantly — no signup required.
          </p>
        </div>

        {/* Two clean buttons — no banner, no extra UI */}
        <div className="flex flex-col sm:flex-row items-center gap-3">
          <Button size="lg" onClick={handleCreate} loading={loading} className="min-w-48">
            Create endpoint
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => window.open('https://github.com', '_blank')}>
            View on GitHub
          </Button>
        </div>

        {/* Quick usage hint */}
        <div className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-left max-w-md w-full">
          <p className="text-xs text-muted-foreground mb-1.5 font-mono">Quick start</p>
          <code className="text-xs font-mono text-foreground block leading-relaxed">
            curl -X POST https://your-url/r/&#123;id&#125; \<br />
            {'  '}-H "Content-Type: application/json" \<br />
            {'  '}-d '&#123;"hello":"world"&#125;'
          </code>
        </div>
      </section>

      <Separator />

      {/* ── Features ── */}
      <section className="py-20 px-4">
        <div className="mx-auto max-w-5xl">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-semibold tracking-tight">Everything you need to debug webhooks</h2>
            <p className="text-sm text-muted-foreground mt-2">No fluff. Just the tools.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {FEATURES.map(({ icon: Icon, title, description }) => (
              <div
                key={title}
                className="rounded-lg border border-border bg-card p-5 space-y-3 hover:bg-accent/50 transition-colors"
              >
                <div className="h-8 w-8 rounded-md border border-border flex items-center justify-center">
                  <Icon className="h-4 w-4 text-foreground" />
                </div>
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Separator />

      {/* ── How it works ── */}
      <section className="py-20 px-4">
        <div className="mx-auto max-w-3xl">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          </div>
          <div className="space-y-0">
            {STEPS.map(({ n, title, body }, i) => (
              <div key={n} className="flex gap-6">
                <div className="flex flex-col items-center">
                  <div className="h-9 w-9 rounded-full border border-border flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-mono text-muted-foreground">{n}</span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className="w-px flex-1 bg-border my-2" />
                  )}
                </div>
                <div className="pb-10 pt-1.5 min-w-0">
                  <h3 className="text-sm font-semibold mb-1">{title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-center">
            <Button size="lg" onClick={handleCreate} loading={loading} className="min-w-48">
              Get started
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Footer ── */}
      <footer className="py-8 px-4">
        <div className="mx-auto max-w-5xl flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Terminal className="h-3 w-3" />
            <span>webhook inspector</span>
          </div>
          <span>Self-hosted · Requests expire after 48 hours</span>
        </div>
      </footer>
    </div>
  )
}
