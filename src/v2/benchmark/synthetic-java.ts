import fs from 'node:fs';
import path from 'node:path';

export interface GenerateSyntheticJavaOptions {
  root: string;
  files: number;
  modules?: number;
}

export interface GenerateSyntheticJavaResult {
  root: string;
  files: number;
  modules: number;
}

export function generateSyntheticJavaRepo(options: GenerateSyntheticJavaOptions): GenerateSyntheticJavaResult {
  const root = path.resolve(options.root);
  const files = Math.max(1, options.files);
  const modules = Math.max(1, options.modules ?? Math.ceil(files / 1000));

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.gradle'), `rootProject.name = 'synthetic-enterprise'\n`);

  let generated = 0;
  for (let moduleIdx = 0; moduleIdx < modules && generated < files; moduleIdx++) {
    const moduleName = `module-${moduleIdx}`;
    const moduleRoot = path.join(root, moduleName);
    fs.mkdirSync(path.join(moduleRoot, 'src', 'main', 'java', 'com', 'example', moduleName.replace('-', '')), { recursive: true });
    fs.writeFileSync(path.join(moduleRoot, 'build.gradle'), `plugins { id 'java' }\n`);

    const packageName = `com.example.${moduleName.replace('-', '')}`;
    for (let i = 0; i < Math.ceil(files / modules) && generated < files; i++, generated++) {
      const className = `Service${moduleIdx}_${i}`;
      const controller = generated % 20 === 0;
      const entity = generated % 25 === 0;
      const annotations = controller
        ? '@Path("/api/' + moduleName + '/' + i + '")\n'
        : entity
          ? '@Entity\n'
          : '@Stateless\n';
      const methodAnnotation = controller ? '  @GET\n' : '';
      const body = `package ${packageName};

import jakarta.ejb.Stateless;
import jakarta.persistence.Entity;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

${annotations}public class ${className} {
${methodAnnotation}  public String handle${i}() {
    return "${className}";
  }
}
`;
      fs.writeFileSync(
        path.join(moduleRoot, 'src', 'main', 'java', 'com', 'example', moduleName.replace('-', ''), `${className}.java`),
        body,
      );
    }
  }

  return { root, files: generated, modules };
}
