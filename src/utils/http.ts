import axios, {
  AxiosHeaders,
  AxiosInstance,
  AxiosRequestConfig,
  InternalAxiosRequestConfig,
  AxiosRequestHeaders,
} from 'axios'
import NProgress from '@/config/nprogress'
import 'nprogress/nprogress.css'
import { UserStore } from '@/stores/modules/user'
import { ElMessage } from 'element-plus'

const instance: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_APP_BASE_API || 'http://localhost:8080',
  timeout: 20000, // 设置超时时间 20秒
  headers: {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  },
  withCredentials: false,
})

const publicAuthEndpoints = [
  '/user/login',
  '/user/register',
  '/user/sendVerificationCode',
  '/user/resetUserPassword',
]

const isPublicAuthRequest = (url?: string) => {
  const requestPath = url?.split('?')[0]
  return !!requestPath && publicAuthEndpoints.some((endpoint) => requestPath.endsWith(endpoint))
}

// 请求拦截器
instance.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // 开启进度条
    NProgress.start()

    // Public authentication endpoints must not inherit a stale session token.
    if (isPublicAuthRequest(config.url)) {
      return config
    }

    // 从 pinia 中获取token
    const userStore = UserStore()
    const token = userStore.userInfo?.token

    if (token) {
      // 确保headers对象存在并且是正确的类型
      if (!config.headers) {
        config.headers = {} as AxiosRequestHeaders
      }
      // 添加Bearer前缀
      config.headers.Authorization = token
    }

    // console.log('请求URL:', config.url)
    // console.log('请求头:', config.headers)
    return config
  },
  (error) => {
    console.error('请求错误:', error)
    return Promise.reject(error)
  }
)

// 响应拦截器
instance.interceptors.response.use(
  (response) => {
    // 关闭进度条
    NProgress.done()
    const { data } = response
    return data
  },
  (error) => {
    // 关闭进度条
    NProgress.done()

    if (error.response) {
      switch (error.response.status) {
        case 401:
          if (error.config?.url?.endsWith('/user/login')) {
            ElMessage.error('邮箱或密码错误')
          } else if (!isPublicAuthRequest(error.config?.url)) {
            const userStore = UserStore()
            const requestToken = AxiosHeaders.from(error.config?.headers).get('Authorization')
            const currentToken = userStore.userInfo?.token

            // Ignore late responses from a session that has already been replaced.
            if (requestToken && requestToken === currentToken) {
              userStore.clearUserInfo()
              ElMessage.error('登录已过期，请重新登录')
            } else if (!requestToken && !currentToken) {
              ElMessage.error('请先登录')
            }
          }
          break
        case 403:
          ElMessage.error('没有权限')
          break
        case 404:
          ElMessage.error('请求的资源不存在')
          break
        case 500:
          ElMessage.error('服务器错误')
          break
        default:
          ElMessage.error('网络错误')
      }
    } else {
      ElMessage.error('网络连接失败')
    }

    return Promise.reject(error)
  }
)

// 封装request方法
export const http = <T>(
  method: 'get' | 'post' | 'put' | 'delete' | 'patch',
  url: string,
  config?: Omit<AxiosRequestConfig, 'method' | 'url'>
): Promise<T> => {
  return instance({ method, url, ...config })
}

// 封装get方法
export const httpGet = <T>(url: string, params?: object): Promise<T> =>
  instance.get(url, { params })

// 封装post方法
export const httpPost = <T>(
  url: string,
  data?: object,
  header?: object
): Promise<T> => instance.post(url, data, { headers: header })

// 封装upload方法
export const httpUpload = <T>(
  url: string,
  formData: FormData,
  header?: object
): Promise<T> => {
  return instance.post(url, formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...header,
    },
  })
}
