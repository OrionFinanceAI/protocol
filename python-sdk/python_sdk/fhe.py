import tenseal as ts

def run_keygen():
    context = ts.context(
        ts.SCHEME_TYPE.CKKS,
        poly_modulus_degree=8192,
        coeff_mod_bit_sizes=[60, 40, 40, 60]
    )
    context.generate_galois_keys()
    context.generate_relin_keys()
    context.global_scale = 2**40

    public_context = context.copy()
    public_context.make_context_public()
    with open("context.public.tenseal", "wb") as f:
        f.write(public_context.serialize())

    with open("context.secret.tenseal", "wb") as f:
        f.write(context.serialize(save_secret_key=True))

    print("✅ Keys generated and saved.")


def client_encrypt():
    with open("context.public.tenseal", "rb") as f:
        public_context = ts.context_from(f.read())

    plaintext_data = [1.0, 2.0, 3.0]
    enc_vector = ts.ckks_vector(public_context, plaintext_data)

    with open("encrypted_data.bin", "wb") as f:
        f.write(enc_vector.serialize())

    print("🔒 Client encrypted data:", plaintext_data)


def compute_server_evaluation():
    with open("context.public.tenseal", "rb") as f:
        public_context = ts.context_from(f.read())

    with open("encrypted_data.bin", "rb") as f:
        enc_vector = ts.ckks_vector_from(public_context, f.read())

    enc_result = enc_vector * 10

    with open("encrypted_result.bin", "wb") as f:
        f.write(enc_result.serialize())

    print("🧮 Compute server applied computation.")


def decryptor_decrypt():
    with open("context.secret.tenseal", "rb") as f:
        secret_context = ts.context_from(f.read())

    with open("encrypted_result.bin", "rb") as f:
        enc_result = ts.ckks_vector_from(secret_context, f.read())

    result = enc_result.decrypt(secret_key=secret_context.secret_key())
    print("🔓 Decrypted result:", result)