import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Webhook, RefreshCcw, Clock, Globe, Github } from 'lucide-react'
import { Button } from '../components/ui/button'
import { ThemeToggle } from '../components/ThemeToggle'
import { api } from '../api/client'

const FEATURES = [
  {
    icon: Webhook,
    title: 'Real-time',
    description: 'Requests appear the moment they arrive via WebSocket — zero polling.',
  },
  {
    icon: Globe,
    title: 'Any method',
    description: 'GET, POST, PUT, PATCH, DELETE — every verb, every content type.',
  },
  {
    icon: RefreshCcw,
    title: 'Replay',
    description: 'Resend any captured request to a target URL with one click.',
  },
  {
    icon: Clock,
    title: '48 h TTL',
    description: 'Requests are automatically purged after 48 hours. No cleanup needed.',
  },
]

const STORAGE_KEY = 'wi-last-endpoint'

export function HomePage() {
  const [loading, setLoading] = useState(false)
  const [existingId, setExistingId] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      api.getEndpoint(saved)
        .then(() => setExistingId(saved))
        .catch(() => localStorage.removeItem(STORAGE_KEY))
    }
  }, [])

  const handleCreate = async () => {
    setLoading(true)
    try {
      if (existingId) {
        navigate(`/e/${existingId}`)
        return
      }
      const ep = await api.createEndpoint()
      localStorage.setItem(STORAGE_KEY, ep.id)
      navigate(`/e/${ep.id}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">

      {/* ── Navbar ── */}
      <header className="fixed top-0 left-0 right-0 z-40">
        <div className="mx-auto max-w-5xl px-6 h-16 flex items-center justify-between">

          {/* Logo */}
          <div className="flex items-center gap-2">
            <Webhook className="h-4 w-4 text-foreground" strokeWidth={2} />
            <span className="text-sm font-semibold tracking-tight">webhooks</span>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-1">
            <a
              href="https://github.com/tarunbtw/webhook-inspector"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View on GitHub"
              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <Github className="h-4 w-4" />
            </a>
            <ThemeToggle />
            <div className="w-px h-4 bg-border mx-1" />
            <Button size="sm" onClick={handleCreate} loading={loading} className="gap-1.5">
              Get started
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 pt-32 pb-28">
        <div className="max-w-xl space-y-5">

          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight leading-[1.1]">
            Inspect webhooks<br />
            <span className="text-muted-foreground font-medium">in real time.</span>
          </h1>

          <p className="text-base text-muted-foreground leading-relaxed max-w-sm mx-auto">
            Get a unique URL. Send any HTTP request. See headers, body, and
            query params arrive live — no account required.
          </p>

          <div className="pt-2 flex items-center justify-center">
            <Button size="lg" onClick={handleCreate} loading={loading} className="min-w-44 gap-2">
              Create endpoint
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="pb-28 px-6">
        <div className="mx-auto max-w-4xl">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden border border-border">
            {FEATURES.map(({ icon: Icon, title, description }) => (
              <div
                key={title}
                className="bg-card p-6 space-y-3 hover:bg-accent/40 transition-colors"
              >
                <Icon className="h-4 w-4 text-foreground" strokeWidth={1.75} />
                <div>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed mt-1">
                    {description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="pb-10 px-6">
        <div className="flex flex-col items-center gap-1">
          <p className="text-xs text-muted-foreground/70 font-medium">webhooks</p>
          <p className="text-xs text-muted-foreground/40">built with Go</p>
        </div>
      </footer>

    </div>
  )
}
