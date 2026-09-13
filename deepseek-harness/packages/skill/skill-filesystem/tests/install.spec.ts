import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SkillInstallError,
  createNodeSkillFileWriter,
  decodeInstallScope,
  installSkillFile,
  isWithinRoot,
  locateSkillFile,
  renderSkillFile,
  resolveInstallRoot,
  resolveSkillInstallDir,
  setSkillEnabled,
  upsertInvocationFlags,
  validateSkillDocument,
  type SkillFileWriter,
} from '../src/install.ts'

const VALID = '---\nname: code-review\ndescription: Review code.\n---\n\nFollow the checklist.\n'

/** In-memory writer for failure-branch coverage. */
function memoryWriter(files: Map<string, string> = new Map()): SkillFileWriter & { files: Map<string, string> } {
  return {
    files,
    makeDir: () => Promise.resolve(),
    writeNew: (path, text) => {
      if (files.has(path)) return Promise.reject(new SkillInstallError('already_exists', `skill file ${path} already exists`))
      files.set(path, text)
      return Promise.resolve()
    },
    read: path => Promise.resolve(files.get(path)),
    overwrite: (path, text) => {
      files.set(path, text)
      return Promise.resolve()
    },
  }
}

function expectInstallError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SkillInstallError)
    expect((error as SkillInstallError).code).toBe(code)
    return
  }
  throw new Error(`expected SkillInstallError ${code}`)
}

describe('decodeInstallScope', () => {
  it('accepts the five writable scopes', () => {
    for (const scope of ['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'custom'] as const) {
      expect(decodeInstallScope(scope)).toBe(scope)
    }
  })

  it.each([undefined, null, '', 'bundled', 'PROJECT-DSH', 42])('rejects scope %#', (value) => {
    expectInstallError(() => decodeInstallScope(value), 'invalid_scope')
  })
})

describe('resolveInstallRoot', () => {
  const roots = {
    projectDsh: '/proj/.dsh/skills',
    projectAgents: '/proj/.agents/skills',
    userDsh: '/home/.dsh/skills',
    userAgents: '/home/.agents/skills',
    custom: ['/custom/skills'],
  }

  it('resolves each scope to its root', () => {
    expect(resolveInstallRoot(roots, 'project-dsh')).toContain('.dsh')
    expect(resolveInstallRoot(roots, 'project-agents')).toContain('.agents')
    expect(resolveInstallRoot(roots, 'user-dsh')).toContain('.dsh')
    expect(resolveInstallRoot(roots, 'user-agents')).toContain('.agents')
  })

  it('rejects unavailable project roots without a workspace', () => {
    expectInstallError(() => resolveInstallRoot({ custom: [] }, 'project-dsh'), 'invalid_scope')
  })

  it('uses the first custom root when custom_dir is omitted', () => {
    expect(resolveInstallRoot(roots, 'custom')).toContain('custom')
  })

  it('rejects custom scope without configured roots or with a foreign dir', () => {
    expectInstallError(() => resolveInstallRoot({ custom: [] }, 'custom'), 'invalid_scope')
    expectInstallError(() => resolveInstallRoot(roots, 'custom', '/elsewhere'), 'invalid_scope')
  })

  it('accepts a configured custom dir', () => {
    expect(resolveInstallRoot(roots, 'custom', '/custom/skills')).toContain('custom')
  })
})

describe('isWithinRoot and resolveSkillInstallDir', () => {
  it('keeps names inside the root and rejects escapes', () => {
    expect(isWithinRoot('/a/b', '/a/b/c')).toBe(true)
    expect(isWithinRoot('/a/b', '/a/b')).toBe(true)
    expect(isWithinRoot('/a/b', '/etc')).toBe(false)
    expect(isWithinRoot('/a/b', '/a/b/../escape')).toBe(false)
    expect(isWithinRoot('/a/b', '../sibling')).toBe(false)
  })

  it('resolves kebab names and rejects the .system bucket by grammar', () => {
    expect(resolveSkillInstallDir('/root', 'code-review')).toBe(join(resolveInstallRoot(
      { custom: ['/root'] },
      'custom',
    ), 'code-review'))
    for (const name of ['', 'Code-Review', 'code_review', '.system', '../escape', 'a/b']) {
      expectInstallError(() => resolveSkillInstallDir('/root', name), 'invalid_name')
    }
  })
})

describe('validateSkillDocument', () => {
  it('accepts a complete document with normalized invocation controls', () => {
    const doc = validateSkillDocument(
      '---\nname: code-review\ndescription: Review code.\nwhenToUse: reviews\ndisable-model-invocation: yes\nuser-invocable: 0\n---\n\nBody text.\n',
    )
    expect(doc).toEqual({
      name: 'code-review',
      description: 'Review code.',
      body: 'Body text.',
      whenToUse: 'reviews',
      invocation: { disableModelInvocation: true, userInvocable: false },
    })
    const numeric = validateSkillDocument(
      '---\nname: code-review\ndescription: Review code.\ndisable-model-invocation: 1\nuser-invocable: \'off\'\n---\n\nBody text.\n',
    )
    expect(numeric.invocation).toEqual({ disableModelInvocation: true, userInvocable: false })
    const quoted = validateSkillDocument(
      '---\nname: code-review\ndescription: Review code.\ndisable-model-invocation: \'1\'\nuser-invocable: \'0\'\n---\n\nBody text.\n',
    )
    expect(quoted.invocation).toEqual({ disableModelInvocation: true, userInvocable: false })
  })

  it('accepts documents without optional fields', () => {
    expect(validateSkillDocument(VALID)).toEqual({
      name: 'code-review',
      description: 'Review code.',
      body: 'Follow the checklist.',
      invocation: {},
    })
  })

  it.each([
    [42, 'invalid_document'],
    ['no envelope here', 'missing_frontmatter'],
    ['---\nname: x\n', 'missing_frontmatter'],
    ['---\nname: [unclosed\n---\n\nBody.\n', 'invalid_frontmatter'],
    ['---\n42\n---\n\nBody.\n', 'invalid_frontmatter'],
    ['---\ndescription: D.\n---\n\nBody.\n', 'missing_name'],
    ['---\nname: Bad_Name\ndescription: D.\n---\n\nBody.\n', 'invalid_name'],
    ['---\nname: good-name\n---\n\nBody.\n', 'missing_description'],
    ['---\nname: good-name\ndescription: D.\n---\n\n   \n', 'invalid_body'],
    ['---\nname: good-name\ndescription: D.\nwhenToUse: 42\n---\n\nBody.\n', 'invalid_document'],
    ['---\nname: good-name\ndescription: D.\nmetadata: [1]\n---\n\nBody.\n', 'invalid_document'],
    ['---\nname: good-name\ndescription: D.\ndisableModelInvocation: true\n---\n\nBody.\n', 'invalid_invocation'],
    ['---\nname: good-name\ndescription: D.\nmodelInvocable: false\n---\n\nBody.\n', 'invalid_invocation'],
    ['---\nname: good-name\ndescription: D.\nuserInvocable: true\n---\n\nBody.\n', 'invalid_invocation'],
    ['---\nname: good-name\ndescription: D.\ndisable-model-invocation: sometimes\n---\n\nBody.\n', 'invalid_invocation'],
    ['---\nname: good-name\ndescription: D.\ndisable-model-invocation: 42\n---\n\nBody.\n', 'invalid_invocation'],
    ['---\nname: good-name\ndescription: D.\nuser-invocable: [true]\n---\n\nBody.\n', 'invalid_invocation'],
  ])('rejects document %#', (text, code) => {
    expectInstallError(() => validateSkillDocument(text), code)
  })
})

describe('renderSkillFile', () => {
  it('renders canonical text that validates and quotes YAML-significant content', () => {
    const text = renderSkillFile({
      name: 'code-review',
      description: 'Review code: fast & "quoted".',
      body: 'Follow the checklist.',
      whenToUse: 'reviews',
      disableModelInvocation: true,
      userInvocable: false,
    })
    expect(text.endsWith('\n')).toBe(true)
    expect(validateSkillDocument(text)).toEqual({
      name: 'code-review',
      description: 'Review code: fast & "quoted".',
      body: 'Follow the checklist.',
      whenToUse: 'reviews',
      invocation: { disableModelInvocation: true, userInvocable: false },
    })
  })

  it('renders disabled defaults without a usage hint', () => {
    const text = renderSkillFile({
      name: 'code-review',
      description: 'Review code.',
      body: 'Follow the checklist.',
      disableModelInvocation: false,
      userInvocable: true,
    })
    expect(validateSkillDocument(text)).toEqual({
      name: 'code-review',
      description: 'Review code.',
      body: 'Follow the checklist.',
      invocation: { disableModelInvocation: false, userInvocable: true },
    })
  })

  it.each([
    [{ name: 'Bad', description: 'D.', body: 'B.' }, 'invalid_name'],
    [{ name: 'good-name', description: '', body: 'B.' }, 'missing_description'],
    [{ name: 'good-name', description: 'D.', body: '   ' }, 'invalid_body'],
  ])('rejects input %#', (input, code) => {
    expectInstallError(() => renderSkillFile(input), code)
  })
})

describe('upsertInvocationFlags', () => {
  it('inserts the enabled pair into a flagless document', () => {
    const next = upsertInvocationFlags(VALID, true)
    expect(next).toContain('disable-model-invocation: false\nuser-invocable: true\n---')
    expect(validateSkillDocument(next).invocation).toEqual({ disableModelInvocation: false, userInvocable: true })
  })

  it('rewrites loose flag forms canonically and stays byte-identical when exact', () => {
    const loose = '---\nname: code-review\ndescription: Review code.\ndisable-model-invocation: yes\nuser-invocable: off\n---\n\nBody.\n'
    const next = upsertInvocationFlags(loose, false)
    expect(next).toContain('disable-model-invocation: true\nuser-invocable: false\n---')
    expect(next).toContain('\n\nBody.\n')
    expect(upsertInvocationFlags(next, false)).toBe(next)
  })

  it('inserts only the missing flag when one is already present', () => {
    const modelOnly = '---\nname: code-review\ndescription: Review code.\ndisable-model-invocation: true\n---\n\nBody.\n'
    const withUser = upsertInvocationFlags(modelOnly, false)
    expect(withUser).toContain('disable-model-invocation: true\nuser-invocable: false\n---')
    const userOnly = '---\nname: code-review\ndescription: Review code.\nuser-invocable: false\n---\n\nBody.\n'
    const withModel = upsertInvocationFlags(userOnly, false)
    expect(withModel).toContain('user-invocable: false\ndisable-model-invocation: true\n---')
    expect(validateSkillDocument(withUser).invocation).toEqual({
      disableModelInvocation: true,
      userInvocable: false,
    })
  })

  it('preserves CRLF documents without normalizing line endings', () => {
    const crlf = '---\r\nname: code-review\r\ndescription: Review code.\r\n---\r\n\r\nBody.\r\n'
    const next = upsertInvocationFlags(crlf, true)
    expect(next.includes('\r\n')).toBe(true)
    expect(next.includes('disable-model-invocation: false\r\nuser-invocable: true\r\n---')).toBe(true)
  })

  it('rejects documents without an envelope', () => {
    expectInstallError(() => upsertInvocationFlags('plain text', true), 'missing_frontmatter')
  })
})

describe('installSkillFile over a memory writer', () => {
  // tmpdir() roots resolve identically on every platform; POSIX-style
  // literals do not (drive-relative on Windows).
  const root = join(tmpdir(), 'dsh-install-spec-root')
  const input = { name: 'code-review', description: 'Review code.', body: 'Follow the checklist.' }

  it('installs a bundle and refuses to overwrite without the flag', async () => {
    const writer = memoryWriter()
    const first = await installSkillFile(writer, root, input)
    expect(first.path).toBe(join(root, 'code-review', 'SKILL.md'))
    expect(validateSkillDocument(writer.files.get(first.path)).name).toBe('code-review')
    await expect(installSkillFile(writer, root, input)).rejects.toMatchObject({ code: 'already_exists' })
    const second = await installSkillFile(writer, root, { ...input, body: 'New body.' }, { overwrite: true })
    expect(second).toEqual(first)
    expect(validateSkillDocument(writer.files.get(first.path)).body).toBe('New body.')
  })

  it('rejects invalid names before touching the writer', async () => {
    const writer = memoryWriter()
    await expect(installSkillFile(writer, root, { ...input, name: 'Bad' })).rejects.toMatchObject({
      code: 'invalid_name',
    })
    expect(writer.files.size).toBe(0)
  })

  it('wraps writer failures with operation context', async () => {
    // A foreign string rejection exercises the non-Error diagnostic path.
    const failing: SkillFileWriter = {
      ...memoryWriter(),
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the point of this case.
      makeDir: () => Promise.reject('disk gone'),
    }
    await expect(installSkillFile(failing, root, input)).rejects.toMatchObject({ code: 'write_failed' })
    const writeFailing: SkillFileWriter = {
      ...memoryWriter(),
      writeNew: () => Promise.reject(new Error('disk gone')),
    }
    await expect(installSkillFile(writeFailing, root, input)).rejects.toMatchObject({ code: 'write_failed' })
  })
})

describe('locateSkillFile and setSkillEnabled', () => {
  const root = join(tmpdir(), 'dsh-install-spec-root')

  it('prefers the bundle layout over the flat sibling', async () => {
    const writer = memoryWriter()
    writer.files.set(join(root, 'code-review.md'), VALID)
    expect(await locateSkillFile(writer, root, 'code-review')).toBe(join(root, 'code-review.md'))
    writer.files.set(join(root, 'code-review', 'SKILL.md'), VALID)
    expect(await locateSkillFile(writer, root, 'code-review')).toBe(join(root, 'code-review', 'SKILL.md'))
    expect(await locateSkillFile(writer, root, 'missing')).toBeUndefined()
  })

  it('maps read failures to write_failed', async () => {
    const failing: SkillFileWriter = {
      ...memoryWriter(),
      read: () => Promise.reject(new Error('io gone')),
    }
    await expect(locateSkillFile(failing, root, 'code-review')).rejects.toMatchObject({ code: 'write_failed' })
  })

  it('toggles flags and skips the write when already exact', async () => {
    const writer = memoryWriter()
    const path = join(root, 'code-review', 'SKILL.md')
    writer.files.set(path, VALID)
    expect(await setSkillEnabled(writer, path, false)).toEqual({ path, enabled: false })
    expect(validateSkillDocument(writer.files.get(path)).invocation).toEqual({
      disableModelInvocation: true,
      userInvocable: false,
    })
    expect(await setSkillEnabled(writer, path, false)).toEqual({ path, enabled: false })
    expect(await setSkillEnabled(writer, path, true)).toEqual({ path, enabled: true })
  })

  it('rejects missing files and non-skill documents', async () => {
    const writer = memoryWriter()
    await expect(setSkillEnabled(writer, join(root, 'missing.md'), true)).rejects.toMatchObject({ code: 'not_found' })
    const plain = join(root, 'plain.md')
    writer.files.set(plain, 'no envelope')
    await expect(setSkillEnabled(writer, plain, true)).rejects.toMatchObject({ code: 'not_a_skill' })
  })

  it('maps toggle write failures', async () => {
    const writer = memoryWriter()
    const path = join(root, 'code-review', 'SKILL.md')
    writer.files.set(path, VALID)
    const failing: SkillFileWriter = {
      ...writer,
      overwrite: () => Promise.reject(new Error('disk gone')),
    }
    await expect(setSkillEnabled(failing, path, true)).rejects.toMatchObject({ code: 'write_failed' })
  })

  it('maps toggle read failures', async () => {
    const failing: SkillFileWriter = {
      ...memoryWriter(),
      read: () => Promise.reject(new Error('io gone')),
    }
    await expect(setSkillEnabled(failing, join(root, 'code-review', 'SKILL.md'), true)).rejects.toMatchObject({
      code: 'write_failed',
    })
  })
})

describe('node writer round-trip on a temporary directory', () => {
  it('installs, locates, toggles, and validates through real files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-install-'))
    try {
      const writer = createNodeSkillFileWriter()
      const { dir, path } = await installSkillFile(writer, root, {
        name: 'code-review',
        description: 'Review code.',
        body: 'Follow the checklist.',
      })
      expect(await locateSkillFile(writer, root, 'code-review')).toBe(path)
      expect(validateSkillDocument(await readFile(path, 'utf8')).name).toBe('code-review')
      await expect(installSkillFile(writer, root, {
        name: 'code-review',
        description: 'Review code.',
        body: 'Other.',
      })).rejects.toMatchObject({ code: 'already_exists' })
      expect(await setSkillEnabled(writer, path, false)).toEqual({ path, enabled: false })
      expect(dir.startsWith(root)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps host filesystem failures to stable codes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-install-'))
    try {
      const writer = createNodeSkillFileWriter()
      expect(await writer.read(join(root, 'missing.md'))).toBeUndefined()
      // NUL paths reject with a keyed TypeError on every platform.
      const nulPath = String.fromCharCode(0)
      await expect(Promise.resolve().then(() => writer.read(nulPath))).rejects.toMatchObject({ code: 'write_failed' })
      await writer.overwrite(join(root, 'blocking'), 'file, not dir')
      await expect(writer.writeNew(join(root, 'blocking', 'SKILL.md'), 'x')).rejects.toMatchObject({
        code: 'write_failed',
      })
      await expect(writer.overwrite(join(root, 'blocking', 'SKILL.md'), 'x')).rejects.toMatchObject({
        code: 'write_failed',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
