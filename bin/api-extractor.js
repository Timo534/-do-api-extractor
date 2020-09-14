#!/usr/bin/env node

const path = require('path')
const fs = require('fs-extra')
const { flowRight, curry } = require('lodash')
const axios = require('axios')
const stringify = require('json-stable-stringify-without-jsonify')
const enquirer = require('enquirer')
const color = require('colors-console')

const defaultConfig = {
  serverAddress: '',
  tag: '',
  outputDir: 'apiExtractor',
  fileName: 'apiResult'
}
let realUrl = `${defaultConfig.serverAddress}/v2/api-docs`
let saveDir = path.join(process.cwd(), `${defaultConfig.outputDir}/${defaultConfig.fileName}.json`)
const configFileName = '.apiextractorconfig.js'
const apiDescTem = {
  description: '',
  url: '',
  method: ''
}
const apiKeyDescTem = {
  type: '',
  description: ''
}
const paramsIn = [
  {
    value: 'query',
    key: 'params'
  },
  {
    value: 'body',
    key: 'data'
  },
  {
    value: 'formData',
    key: 'data'
  },
  {
    value: 'path',
    key: 'path'
  }
]
const reviseType = {
  integer: 'number'
}

// 初始化配置文件
if (process.argv.includes('--init')) {
  promptUser()
} else {
  startWork().catch(err => {
    console.log(color('red', err))
  })
}

// ------  工具函数START ------------
// ------  工具函数END ------------

// ------  业务函数START ------------

/** 方法说明
 * @method 方法名
 * @param {参数类型} 参数名 参数说明
 * @return {返回值类型} 返回值说明
*/
function readConfig () {
  try {
    const configFile = require(path.join(process.cwd(), configFileName))
    Object.assign(defaultConfig, configFile)
    return Promise.resolve('读取配置成功')
  } catch (e) {
    onFatalError()
    return Promise.reject('读取配置失败')
  }
}

/** 捕获并报告意外错误
 * @method onFatalError
 * @param {参数类型} 参数名 参数说明
 * @return {返回值类型} 返回值说明
 */
function onFatalError () {
  const { version } = require('../package.json')

  console.error(`
Oops! Something went wrong! :(

api-extractor: ${version}

api-extractor couldn't find a configuration file. To set up a configuration file for this project, please run:

    api-extractor --init
`)
}

/** 将配置文件添加到.gitignore文件中
 * @method addIgnore
 * @return {返回值类型} 返回值说明
*/
function addIgnore () {
  try {
    const ignoreFile = fs.readFileSync(path.join(process.cwd(), '.gitignore'))
    if (!ignoreFile.toString().includes(configFileName)) {
      fs.writeFileSync(path.join(process.cwd(), '.gitignore'), ignoreFile + `\n\n${configFileName}`)
    }
  } catch (e) {
    fs.writeFileSync(path.join(process.cwd(), '.gitignore'), configFileName)
  }
}

/** 在命令提示符下询问一些问题
 * @method promptUser
 * @param {参数类型} 参数名 参数说明
 * @return {Promise} 提示结果的承诺
 */
function promptUser () {
  return enquirer.prompt([
    {
      type: 'input',
      name: 'serverAddress',
      message: '请输入接口所在的服务器地址：'
    },
    {
      type: 'input',
      name: 'tag',
      message: '请输入你想获取接口的标签名（多个可以使用“ | ”隔开，为空默认获取全部接口数据）：'
    },
    {
      type: 'input',
      name: 'outputDir',
      message: '你希望输出的文件存在在什么目录下（例子：假如你想存放在根目录下的apiResult/api目录下，则输入apiResult/api即可，默认为apiExtractor）：'
    },
    {
      type: 'input',
      name: 'fileName',
      message: '想给输出的文件取什么名字？请输入（默认为apiResult）：'
    }
  ]).then(answers => {
    for (const key of Reflect.ownKeys(answers)) {
      !answers[key] && delete answers[key]
    }
    if (answers.tag) {
      answers.tag = answers.tag.split('|')
    }
    const config = Object.assign({}, defaultConfig, answers)
    addIgnore()
    writeFile(config)
  })
}

function sortByKey (a, b) {
  return a.key > b.key ? 1 : -1
}

/** 在当前工作目录中创建.apiextractorconfig.js文件
 * @method 方法名
 * @param {参数类型} 参数名 参数说明
 * @return {返回值类型} 返回值说明
 */
function writeFile (config) {
  const stringifiedContent = `module.exports = ${stringify(config, { cmp: sortByKey, space: 2 })};\n`
  fs.writeFileSync(path.join(process.cwd(), configFileName), stringifiedContent, 'utf8')
}

/** 获取数据
 *@method getData
 *@param {String} url 获取数据的地址
 *@return {Object} 接口返回的数据
*/
async function getData (url) {
  if (/^(http|https):\/\//.test(url)) {
    const result = await axios.get(url)
      .catch(() => {
        return Promise.reject('访问出错：' + url)
      })
    return result.data
  } else {
    return Promise.reject(`服务器地址必须包含HTTP协议，请前往${path.join(process.cwd(), configFileName)}配置文件修改`)
  }
}

/** 整理数据
 *@method sortData
 *@param {Object} data 需要整理的数据
 *@return {Object} 整理过后的数据
*/
function sortData ({ paths = {} }) {
  const result = {}
  for (const [key, val] of Object.entries(paths)) {
    const { tag } = defaultConfig
    const [[method, pathValue = {}]] = Object.entries(val)
    const { summary: description, parameters = [], tags: [tagName] } = pathValue
    // 通过'/'将路径分割成一个数组并且过滤出用户自定义的tag字段
    const apiUrlSplit = key.split('/').filter(item => item && (!tag || tag.includes(tagName)))
    // 数组的最后一个元素的下标
    const lastIndex = apiUrlSplit.length - 1
    apiUrlSplit.reduce((preResult, value, index) => {
      // 处理path参数
      if (/^{.+}$/.test(value)) {
        value = value.replace(/[{,}]/g, '')
      }
      if (/\./.test(value)) {
        value = value.replace(/\..+/g, '')
      }
      if (index === lastIndex) {
        const handleParamsCurry = curry(handleParams)(tagName, key)
        preResult[value] = Object.assign({}, apiDescTem, {
          description,
          url: key,
          method
        }, handleParamsCurry(parameters))
      } else {
        preResult[value] = preResult[value] || {}
        return preResult[value]
      }
    }, result)
  }
  return result
}

/** 处理请求的参数
 * @method handleApiBody
 * @param {Array} paramsArr 接口的parameters参数
 * @return {Object} 一个包含data或者params属性的对象
*/
function handleParams (tag, url, paramsArr) {
  // 获取key值
  const paramsInArr = paramsIn.filter(item => paramsArr.some(key => key.in === item.value))
  // 没有参数则返回一个error对象
  if (!paramsInArr.length) {
    console.log(`${tag}下${url}接口没有定义参数，请自行确认是否需要定义`)
    return
  }
  const result = {}
  paramsInArr.forEach(paramsIn => {
    // 过滤header参数
    const noHeader = paramsArr.filter(item => item.in === paramsIn.value)
    const lastIndex = noHeader.length - 1
    noHeader.reduce((lastResult, { name, required, type, description }, index) => {
      lastResult[name] = Object.assign({}, apiKeyDescTem, {
        type: reviseType[type] || type || 'string',
        description
      })
      if (required) {
        lastResult[name].required = required
      }
      if (lastIndex === index) {
        result[paramsIn.key] = lastResult
      }
      return lastResult
    }, {})
  })
  return result
}

/** 将数据写入json文件
 * @method writeJson
 * @param {Object} data 需要写入的json数据
 * @return {void}
*/
function writeJson (data = {}) {
  saveDir = path.join(process.cwd(), `${defaultConfig.outputDir}/${defaultConfig.fileName}.json`)
  try {
    fs.writeJsonSync(saveDir, data, { spaces: 2 })
  } catch (e) {
    fs.mkdirsSync(path.join(process.cwd(), defaultConfig.outputDir))
    fs.writeJsonSync(saveDir, data, { spaces: 2 })
  }
  console.log(color('green', `恭喜你呀，提取成功啦！可以在${saveDir}中查看数据`))
}

/**
 * @method startWork
 * @param {参数类型} 参数名 参数说明
 * @return {返回值类型} 返回值说明
*/
async function startWork () {
  const composeFn = flowRight(writeJson, sortData)
  await readConfig()
  realUrl = `${defaultConfig.serverAddress}/v2/api-docs`
  const json = await getData(realUrl)
  fs.writeJsonSync('data.json', json, { spaces: 2 })
  composeFn(json)
}

// ------  业务函数END ------------
