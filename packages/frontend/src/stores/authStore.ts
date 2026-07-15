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
  token: string | null
  refreshToken: string | null
  login: (_email: string, _password: string) => Promise<void>
  logout: () => Promise<void>
  refreshAccessToken: () => Promise<void>
  hasPermission: (_permission: string) => boolean
}

let isRefreshing = false
let refreshSubscribers: Array<(token: string) => void> = []

function onRefreshed(token: string) {
  refreshSubscribers.forEach(cb => cb(token))
  refreshSubscribers = []
}

function subscribeTokenRefresh(cb: (token: string) => void) {
  refreshSubscribers.push(cb)
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      hasPermission: (permission) => {
        const user = get().user
        return Boolean(user && (user.role === 'admin' || user.role === 'owner' || user.permissions?.includes(permission)))
      },
      
      login: async (email, password) => {
        const response = await axios.post('/api/auth/login', { email, password })
        const { user, accessToken, refreshToken } = response.data
        set({ user, token: accessToken, refreshToken })
      },
      
      logout: async () => {
        const token = get().token
        if (token) {
          try {
            await axios.post('/api/auth/logout', {}, {
              headers: { Authorization: `Bearer ${token}` },
              // @ts-ignore
              _skipAuthRefresh: true
            })
          } catch {
            // Ignore logout errors
          }
        }
        set({ user: null, token: null, refreshToken: null })
      },
      
      refreshAccessToken: async () => {
        if (isRefreshing) {
          return new Promise<void>((resolve) => {
            subscribeTokenRefresh((token) => {
              set({ token })
              resolve()
            })
          })
        }
        
        isRefreshing = true
        try {
          const refreshToken = get().refreshToken
          if (!refreshToken) throw new Error('No refresh token')
          
          const response = await axios.post('/api/auth/refresh', { refreshToken })
          const { accessToken, user } = response.data
          set({ token: accessToken, user })
          onRefreshed(accessToken)
        } catch {
          get().logout()
          window.location.href = '/login'
        } finally {
          isRefreshing = false
        }
      }
    }),
    {
      name: 'auth-storage'
    }
  )
)

axios.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  // @ts-ignore
  return config
})

axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config
    if (error.response?.status === 401 && !originalRequest._retry && !(originalRequest as any)._skipAuthRefresh) {
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
