import { appendFileSync, readFileSync } from 'node:fs'
import { isHighestTag } from './version.mjs'

// deploy-pages.yml's check: the tag as the argument, `git ls-remote --tags` output on stdin.
const [tag] = process.argv.slice(2)
const tags = readFileSync(0, 'utf8')
    .split(/\s+/)
    .map((name) => name.replace(/^refs\/tags\//, ''))
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
if (!tag || !tags.length) {
    console.error('Could not read the version tags.')
    process.exit(1)
}
if (isHighestTag(tag, tags)) {
    console.log(`Deploying ${tag}.`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'deploy=true\n')
} else {
    const highest = tags.find((other) => isHighestTag(other, tags))
    console.log(`Not deployed: ${highest} is higher than ${tag}.`)
}
