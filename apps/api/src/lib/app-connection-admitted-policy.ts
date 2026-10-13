import {isDeepStrictEqual} from 'node:util';
import type {OwnerConnectionPolicyDeclaration} from '@deft/app-kit';
/** The caller supplies an already validated current registration admission.
 * Shared resources do not nominate a profile; the exact reviewed policy does. */
export function selectAdmittedConnectionPolicy(policies:readonly OwnerConnectionPolicyDeclaration[],admitted:OwnerConnectionPolicyDeclaration,current:{resource_key:string;runtime_requirement_key:string}){
 const candidates=policies.filter(policy=>policy.key===admitted.key);
 if(candidates.length!==1)return null;const policy=candidates[0]!;
 if(!isDeepStrictEqual(policy,admitted)||!policy.provider_profile_key||policy.resource_key!==current.resource_key||policy.runtime_requirement_key!==current.runtime_requirement_key)return null;
 return policy;
}
