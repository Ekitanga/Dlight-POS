import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import axios from 'axios'

interface User {
  id: string
  email: string
  full_name: string
  role: string
  permissions: string[]
}

interface AuthState {
  user: User | null
  /** Short-lived access token. Kept in memory only, never written to storage. */
  token: string | null
  login: (_email: string, _password: string) => Promise<void>
  logout: () => Promise<void>
  refreshAccessToken: () => Promise<void>
  hasPermission: (_permission: string) => boolean
}

// The refresh token lives in an httpOnly cookie scoped to /api/auth, so page
// scripts can never read it. Only the user's profile (name, role, permissions)
// is persisted so the app shell can render while a fresh access token is fetched.

let refreshInFlight: Promise<void> | null = null

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      hasPermission: (permission) => {
        const user = get().user
        return Boolean(user && (user.role === 'admin' || user.role === 'owner' || user.permissions?.includes(permission)))
      },

      login: async (email, password) => {
        const response = await axios.post('/api/auth/login', { email, password }, {
          // @ts-ignore
          _skipAuthRefresh: true
        })
        const { user, accessToken } = response.data
        set({ user, token: accessToken })
      },

      logout: async () => {
        try {
          await axios.post('/api/auth/logout', {}, {
            // @ts-ignore
            _skipAuthRefresh: true
          })
        } catch {
          // The local sign-out still happens; the server session expires on its own.
        }
        set({ user: null, token: null })
      },

      refreshAccessToken: () => {
        // Concurrent 401s share one refresh request.
        if (refreshInFlight) return refreshInFlight
        refreshInFlight = (async () => {
          try {
            const response = await axios.post('/api/auth/refresh', {}, {
              // @ts-ignore
              _skipAuthRefresh: true
            })
            const { accessToken, user } = response.data
            set({ token: accessToken, user })
          } catch (error) {
            set({ user: null, token: null })
            if (window.location.pathname !== '/login') window.location.href = '/login'
            throw error
          } finally {
            refreshInFlight = null
          }
        })()
        return refreshInFlight
      }
    }),
    {
      name: 'auth-storage',
      version: 1,
      partialize: (state) => ({ user: state.user }),
      // Version 0 stored the access and refresh tokens in localStorage. Drop them.
      migrate: (persisted) => ({ user: (persisted as { user?: User | null } | undefined)?.user ?? null }) as AuthState
    }
  )
)

axios.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !(originalRequest as any)._skipAuthRefresh) {
      originalRequest._retry = true
      try {
        await useAuthStore.getState().refreshAccessToken()
        originalRequest.headers.Authorization = `Bearer ${useAuthStore.getState().token}`
        return axios(originalRequest)
      } catch {
        return Promise.reject(error)
      }
    }
    return Promise.reject(error)
  }
)
