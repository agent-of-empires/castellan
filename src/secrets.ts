import {
	GetSecretValueCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";

const schema = z.object({
	app_id: z.coerce.number().int().positive(),
	installation_id: z.coerce.number().int().positive(),
	private_key: z.string().min(1),
	webhook_secret: z.string().min(1),
});

export type Secrets = z.infer<typeof schema>;

export interface SecretsClient {
	send(cmd: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

/** Reads the App secret (JSON with app_id, installation_id, private_key, webhook_secret). */
export async function loadSecrets(
	arn: string,
	client: SecretsClient = new SecretsManagerClient({}),
): Promise<Secrets> {
	const { SecretString } = await client.send(
		new GetSecretValueCommand({ SecretId: arn }),
	);
	return schema.parse(JSON.parse(SecretString ?? ""));
}
